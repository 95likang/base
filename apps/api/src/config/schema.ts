import { join } from 'node:path'
import { z } from 'zod'
import { ROLES } from '../security/roles'

/**
 * 配置文件结构。每个字段都有默认值，配置文件只需要写"跟默认不一样的部分"。
 * 嵌套对象用 prefault({})：缺省时先补空对象，再由字段默认值逐项填充。
 * 默认值统一回落到原有的环境变量/约定：没有配置文件时行为与改造前一致。
 */
const splitList = (raw: string): string[] =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const ModelConfigSchema = z.object({
  name: z.string().default(() => process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'),
  baseURL: z.string().default(() => process.env.ANTHROPIC_BASE_URL ?? ''),
  apiKey: z.string().default(() => process.env.ANTHROPIC_API_KEY ?? ''),
})

const PluginConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
})

const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(true),
  appId: z.string().default(() => process.env.FEISHU_APP_ID ?? ''),
  appSecret: z.string().default(() => process.env.FEISHU_APP_SECRET ?? ''),
})

const ChannelConfigSchema = z.object({
  feishu: FeishuChannelConfigSchema.prefault({}),
})

const AgentConfigSchema = z.object({
  maxSpawnDepth: z.number().int().min(0).max(5).default(1),
  maxConcurrent: z.number().int().min(1).max(10).default(3),
  defaultTimeout: z.number().int().positive().default(60_000),
})

const SecurityConfigSchema = z.object({
  defaultRole: z.enum(ROLES).default('owner'),
  auditLog: z.boolean().default(true),
  bashTimestamp: z.boolean().default(true),
  /** 可切换全局角色的邮箱白名单；空数组表示不限制（仅限本地/内网） */
  adminEmails: z.array(z.string()).default(() => splitList(process.env.ADMIN_EMAILS ?? '')),
})

const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
})

const UsageConfigSchema = z.object({
  /** 相对路径以 apps/api 为基准解析 */
  trackingFile: z.string().min(1).default('.usage/usage.jsonl'),
})

const ServerConfigSchema = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(() => Number(process.env.PORT ?? 3000)),
  corsOrigins: z
    .array(z.string())
    .default(() =>
      splitList(process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3001'),
    ),
})

const DatabaseConfigSchema = z.object({
  url: z.string().default(() => process.env.DATABASE_URL ?? ''),
})

const AuthConfigSchema = z.object({
  secret: z.string().default(() => process.env.BETTER_AUTH_SECRET ?? ''),
  baseURL: z.string().default(() => process.env.BETTER_AUTH_URL ?? ''),
})

const McpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
})

/** MCP_SERVERS 环境变量是 JSON 数组；格式非法时告警并忽略，不阻断启动 */
function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组')
    return parsed as McpServerConfig[]
  } catch (err) {
    console.warn(`  ⚠ MCP_SERVERS 解析失败，忽略 MCP 配置: ${(err as Error).message}`)
    return []
  }
}

const ToolsConfigSchema = z.object({
  /** 文件工具工作区根目录，相对路径基于进程 cwd 解析 */
  workspaceDir: z
    .string()
    .default(() => process.env.TOOL_WORKSPACE_DIR ?? join(process.cwd(), 'workspace')),
  /** 路径越界守卫；关闭后模型可访问服务器任意路径，仅限本地开发 */
  guard: z.boolean().default(() => process.env.TOOL_WORKSPACE_GUARD !== 'false'),
  tavilyApiKey: z.string().default(() => process.env.TAVILY_API_KEY ?? ''),
  serperApiKey: z.string().default(() => process.env.SERPER_API_KEY ?? ''),
  mcpServers: z
    .array(McpServerConfigSchema)
    .default(() => parseMcpServers(process.env.MCP_SERVERS)),
})

const RagConfigSchema = z.object({
  apiKey: z.string().default(() => process.env.DASHSCOPE_API_KEY ?? ''),
})

export const SuperAgentConfigSchema = z.object({
  model: ModelConfigSchema.prefault({}),
  /** 空数组表示未配置：启动时加载全部可用插件 */
  plugins: z.array(PluginConfigSchema).default([]),
  channels: ChannelConfigSchema.prefault({}),
  agents: AgentConfigSchema.prefault({}),
  security: SecurityConfigSchema.prefault({}),
  cron: CronConfigSchema.prefault({}),
  usage: UsageConfigSchema.prefault({}),
  server: ServerConfigSchema.prefault({}),
  database: DatabaseConfigSchema.prefault({}),
  auth: AuthConfigSchema.prefault({}),
  tools: ToolsConfigSchema.prefault({}),
  rag: RagConfigSchema.prefault({}),
})

export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>
