import type { ToolDefinition } from '../tools/registry'
import { GENUI_TOOL_NAMES, GENUI_TOOLS, toJsonSchemaParameters } from './spec'

/**
 * 生成式 UI 工具：纯渲染型，服务端没有实际业务逻辑。
 *
 * 仍然提供 execute（纯渲染本不需要 execute）：本项目 agentLoop 是手动循环，
 * 没有 tool_result 的历史会让下一轮 Anthropic 请求 400。这里只回一个极短标记，
 * 同时 loop 检测到本步全部调用都是渲染型后立即结束循环，不会多跑一轮模型调用。
 */
export function createGenUITools(): ToolDefinition[] {
  return GENUI_TOOL_NAMES.map((name) => ({
    name,
    description: GENUI_TOOLS[name].description,
    parameters: toJsonSchemaParameters(GENUI_TOOLS[name].schema),
    renderOnly: true,
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async () => ({ rendered: true }),
  }))
}
