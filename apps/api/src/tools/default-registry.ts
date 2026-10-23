import { pluginManager } from '../plugins'
import { ragEmbedder, ragStore } from '../rag/service'
import { skillLoader } from '../skills'
import {
  editFileTool,
  globTool,
  grepTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from './file-tools'
import { getMcpTools } from './mcp-client'
import { createMemoryTool } from './memory-tools'
import { createRagTools } from './rag-tools'
import { ToolRegistry } from './registry'
import { pickSearchTool, startPreviewTool, webFetchTool } from './search-tools'
import { bashTool } from './shell-tools'
import { createSkillTool } from './skill-tools'
import { createToolSearchTool } from './tool-search'
import { calculatorTool, weatherTool } from './utility-tools'

/**
 * 默认工具注册表：内置工具 + MCP + 记忆 / 知识库 / Skill / 插件。
 * 对话路由与 Channel 共用这套装配逻辑；registry 本身是请求级的，每次新建。
 *
 * 放在独立文件（而非 tools/index.ts）是为了让 barrel 保持无副作用：
 * 只导入单个工具的模块不应连带求值 pluginManager / ragStore / skillLoader。
 */
export async function createDefaultToolRegistry(): Promise<ToolRegistry> {
  const registry = new ToolRegistry()
  registry.register(
    weatherTool,
    calculatorTool,
    pickSearchTool(),
    readFileTool,
    writeFileTool,
    listDirectoryTool,
    editFileTool,
    globTool,
    grepTool,
    bashTool,
    webFetchTool,
    startPreviewTool,
    // MCP 外部工具（MCP_SERVERS 未配置时为空数组）——延迟加载，不占初始上下文
    ...(await getMcpTools()),
  )
  // 延迟工具的发现入口：激活后 registry 原地更新 ToolSet，后续步骤立即可用
  registry.register(createToolSearchTool(registry))
  // 记忆工具：LLM 在对话中自主触发保存/读取（写库，独占锁）
  registry.register(createMemoryTool())
  // 知识库工具：导入工作区文档 + 混合检索（与管理页共用同一 store）
  registry.register(...createRagTools(ragStore, ragEmbedder))
  // Skill 工具：系统提示只给索引，模型按需 load 完整指令
  registry.register(createSkillTool(skillLoader))
  // 插件工具：进程级已加载插件注入请求级 registry（加载/卸载影响后续请求）
  registry.register(...pluginManager.getTools())
  return registry
}
