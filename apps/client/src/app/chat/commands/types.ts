/**
 * 斜杠命令系统的类型与 dispatcher。
 * 命令由用户在输入框触发、本地处理（不入消息流、不落库），
 * 各命令模块只从 CommandContext 里取自己需要的依赖。
 */

export type ContextSection = { name: string; tokens: number }
export type ContextSnapshot = {
  modelId: string
  windowTokens: number
  sections: ContextSection[]
  usedTokens: number
  freeTokens: number
  usedPercent: number
}

export type UsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  hitRate: number
  baselineCost: number
  savedCost: number
  steps: number
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export type MemoryItem = {
  id: string
  type: MemoryType
  name: string
  description: string
  expiresAt: string | null
}

/** 记忆体检报告的单项问题 */
export type LintReport = {
  entry: MemoryItem
  issues: { kind: string; message: string }[]
}

/** 命令产生的面板视图（联合类型，page 按 kind 分发渲染） */
export type ChatPanelView =
  | { kind: 'context'; snapshot: ContextSnapshot }
  | { kind: 'usage'; totals: UsageTotals; title: string }
  | { kind: 'memory'; items: MemoryItem[] }
  | { kind: 'lint'; total: number; reports: LintReport[] }

/** 命令可用的依赖：当前会话 + 面板展示回调 + 往消息流里发一条用户消息（如 /dream） */
export interface CommandContext {
  chatId: string | null
  showPanel: (view: ChatPanelView) => void
  send: (text: string) => void
}

/**
 * 返回 true 表示命令已处理（输入不进入消息流），
 * 返回 false 表示不认识，交给下一个 handler。
 */
export type CommandHandler = (cmd: string, ctx: CommandContext) => boolean | Promise<boolean>

/** 责任链：遍历 handlers，第一个返回真值的接管 */
export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return async (cmd, ctx) => {
    for (const h of handlers) {
      if (await h(cmd, ctx)) return true
    }
    return false
  }
}

/** API 地址（与 page.tsx 共用；客户端组件直连 Hono） */
export const API = 'http://localhost:3000'
