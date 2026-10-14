import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolDefinition } from '../lib/tool-registry'

/**
 * MCP 工具接入：通过 stdio transport 连接外部 MCP server，
 * 把远端工具转换为本地 ToolDefinition，经由 ToolRegistry 统一注册。
 *
 * 配置来源：环境变量 MCP_SERVERS（JSON 数组），未配置则不接入任何 server：
 *   MCP_SERVERS='[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"ghp_xxx"}}]'
 */

/** 单个 MCP server 的启动配置 */
interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** 连接超时：npx 首次下载 server 包可能较慢，给足余量 */
const CONNECT_TIMEOUT_MS = 30_000

/**
 * 解析 MCP_SERVERS 环境变量；未设置或格式非法时返回空列表（记日志，不阻断启动）。
 */
function parseServerConfigs(): McpServerConfig[] {
  const raw = process.env.MCP_SERVERS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('MCP_SERVERS 必须是 JSON 数组')
    return parsed as McpServerConfig[]
  } catch (err) {
    console.error('[mcp] MCP_SERVERS 解析失败，忽略 MCP 配置:', err)
    return []
  }
}

/**
 * Windows 下 spawn 无法直接执行 .cmd/.bat 脚本（如 npx），统一经 cmd /c 包装。
 */
function buildCommand(cfg: McpServerConfig): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', cfg.command, ...(cfg.args ?? [])] }
  }
  return { command: cfg.command, args: cfg.args ?? [] }
}

/**
 * 连接单个 MCP server 并列出其工具。
 * 失败时记日志返回空数组：单个 server 不可用不应拖垮整个对话服务。
 */
async function loadServerTools(cfg: McpServerConfig): Promise<ToolDefinition[]> {
  const { command, args } = buildCommand(cfg)
  const transport = new StdioClientTransport({
    command,
    args,
    // 只透传安全的环境变量子集（PATH/HOME 等），避免把 DATABASE_URL、API Key 泄漏给第三方 server 子进程
    env: { ...getDefaultEnvironment(), ...cfg.env },
  })
  const client = new Client({ name: 'base-api', version: '1.0.0' })

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
    const { tools } = await client.listTools()
    clients.push(client)
    console.log(`[mcp] server "${cfg.name}" 已连接，提供 ${tools.length} 个工具`)

    return tools.map((tool) => toToolDefinition(client, cfg.name, tool.name, tool))
  } catch (err) {
    console.error(`[mcp] server "${cfg.name}" 连接失败，跳过:`, err)
    await client.close().catch(() => {})
    return []
  }
}

/** 把 MCP 工具定义转换为注册层的 ToolDefinition */
function toToolDefinition(
  client: Client,
  serverName: string,
  toolName: string,
  tool: { description?: string; inputSchema: Record<string, unknown> },
): ToolDefinition {
  return {
    // 前缀防止与内置工具或其他 server 的工具重名（MCP 惯例：mcp__server__tool）
    name: `mcp__${serverName}__${toolName}`,
    description: `[MCP:${serverName}] ${tool.description ?? toolName}`,
    parameters: tool.inputSchema,
    // MCP 工具的副作用未知，保守按独占执行（registry 默认），也不标记只读
    execute: async (input, { abortSignal }) => {
      const result = await client.callTool(
        { name: toolName, arguments: input },
        undefined,
        // 客户端断开时中止远端调用
        { signal: abortSignal },
      )

      const text = toolsResultToText(result)
      if (result.isError) {
        throw new Error(text)
      }
      return text
    },
  }
}

/** 提取 MCP 返回内容的文本部分；非文本内容（图片/资源）序列化兜底 */
// SDK 1.32 callTool 返回联合类型（任务化分支无 content 字段），收窄为结构断言读取
function toolsResultToText(result: unknown): string {
  const { content } = result as { content?: Array<{ type?: unknown; text?: unknown }> }
  const contents = Array.isArray(content) ? content : []
  const texts = contents.flatMap((c) => (c?.type === 'text' ? [String(c.text)] : []))
  if (texts.length > 0) return texts.join('\n')
  if (contents.length > 0) return JSON.stringify(contents, null, 2)
  return JSON.stringify(result, null, 2)
}

// —— 惰性单例：首次调用时连接一次，之后复用（npx 拉起子进程很重，不能每请求都连）——

let mcpToolsPromise: Promise<ToolDefinition[]> | undefined

/** 已连接的 MCP client（用于进程退出时清理子进程，避免 tsx watch 重启遗留 npx 进程） */
const clients: Client[] = []

/** 获取所有 MCP server 的工具（合并结果）。未配置 MCP_SERVERS 时返回空数组。 */
export function getMcpTools(): Promise<ToolDefinition[]> {
  mcpToolsPromise ??= (async () => {
    const configs = parseServerConfigs()
    if (configs.length === 0) return []
    const toolGroups = await Promise.all(configs.map(loadServerTools))
    const tools = toolGroups.flat()
    // 全部连接失败时不缓存：下次请求重试（避免 npx 首次下载超时导致重启前永久不可用）
    if (tools.length === 0) mcpToolsPromise = undefined
    return tools
  })()
  return mcpToolsPromise
}

// 进程退出时关闭 MCP 子进程（close 会 kill transport 持有的 stdio 子进程）
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    for (const client of clients) {
      client.close().catch(() => {})
    }
  })
}
