/**
 * Prompt Pipe 模式：system prompt 拆成独立模块（pipe），
 * 每个 pipe 是纯函数，接收运行时上下文，自行决定要不要出现在最终 prompt 中。
 * build() 只做拼接，无副作用；同一 builder 实例可跨请求复用。
 */
import { buildMemoryPromptSection, type MemoryEntry } from '../memory/store'

/** 运行时上下文：pipe 据此决定输出内容或返回 null（不出现） */
export interface PromptContext {
  /** 当前激活的工具数量（已进入 ToolSet，不含延迟未激活的） */
  toolCount: number
  /** 延迟工具目录（registry.getDeferredToolSummary()，无延迟工具时为空串） */
  deferredToolSummary: string
  /** 本次请求携带的会话历史消息数（含最新一条用户消息） */
  sessionMessageCount: number
  sessionId: string
  /** 未过期的持久记忆（请求级加载，注入索引供 LLM 引用） */
  memories: MemoryEntry[]
}

type PipeFn = (ctx: PromptContext) => string | null

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = []

  pipe(name: string, fn: PipeFn): this {
    this.pipes.push({ name, fn })
    return this
  }

  build(ctx: PromptContext): string {
    const sections: string[] = []

    for (const { fn } of this.pipes) {
      const result = fn(ctx)
      if (result !== null) {
        sections.push(result)
      }
    }

    return sections.join('\n\n')
  }

  /** 打印每个 pipe 的开关与长度，观测上下文占用 */
  debug(ctx: PromptContext): void {
    console.log('=== Prompt Pipe ===')
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx)
      const status = result !== null ? `[ON] ${result.length} chars` : '[OFF]'
      console.log(`  ${name}: ${status}`)
    }
  }
}

// ── 预定义的 Pipe ────────────────────────────────

export function coreRules(): PipeFn {
  return () => `你是 Super Agent，一个有工具调用能力的 AI 助手。用中文简洁回答。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 回答要简洁直接`
}

export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null
    return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`
  }
}

export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null
    // summary 自带引导语（"需要先通过 tool_search 搜索获取完整定义"），直接透传，避免双重指令
    return ctx.deferredToolSummary.trim()
  }
}

export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null
    return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`
  }
}

/**
 * 持久记忆注入：只注入索引（[id] name — description），
 * 内容靠 memory 工具 read 按需加载（与延迟工具同一懒加载哲学）。
 * 放在 sessionContext 之前：记忆跨请求可能变化，但变化频率低于会话状态，
 * 相对稳定的段放前面利于 prompt cache 命中。
 */
export function memoryContext(): PipeFn {
  return (ctx) => {
    // 索引内容为空时 store 也会返回引导语，这里只处理"未提供"的情况
    return buildMemoryPromptSection(ctx.memories)
  }
}
