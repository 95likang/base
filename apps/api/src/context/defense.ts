/**
 * 三层即时防线：发送给 LLM 前的零 LLM 成本上下文治理（DB 始终保存完整历史，不落库）。
 *
 * - Layer 1 TokenTracker / estimateMessageTokens：token 估算。Tracker 用 API 真实
 *   用量锚定（updateFromAPI）+ 字符增量累加，跨步骤自我纠偏粗估误差。
 * - Layer 2 truncateToolResults：单结果截断（执行层 3k 截断的存量/绕过兜底）+
 *   总字符预算强制（超预算时从最老的工具结果开始清，最后防线）。
 * - Layer 3 ttlPrune：按消息年龄修剪过期工具结果（软修剪留头尾 / 硬清空占位符）。
 *
 * 与 compressor 的分工：本模块（applyDefense）只在请求入口跑一次，治理存量历史；
 * microcompact / summarize 在入口与 agentLoop 每步内跑，治理增量消息。
 * 错误结果（error-text / error-json）豁免截断与软修剪：错误经验对模型有持续参考价值
 * （硬清空不豁免——过期的报错细节没有保留全文的价值）。
 */
import { convertToModelMessages, type ModelMessage, type ToolResultPart, type UIMessage } from 'ai'
import { truncateResult } from '../tools/registry'
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output'

/** 上下文窗口（compressor 的摘要阈值为其 50%，见 CONTEXT_TOKEN_THRESHOLD；view 面板同用） */
export const CONTEXT_WINDOW = 200_000
/** 单个工具结果的兜底截断上限：执行层已截到 3k，这里只拦存量/绕过执行层的超大结果 */
const MAX_SINGLE_RESULT_CHARS = 200_000
/** 全部上下文的总字符预算（约 75% 窗口 × 4 字符/token），超出时从最老开始清 */
const CONTEXT_BUDGET_CHARS = 600_000
/** 最近 N 个工具结果豁免 TTL 修剪（与 compressor.KEEP_RECENT_TOOL_RESULTS 对齐，避免两机制打架） */
const TTL_EXEMPT_RECENT = 3
/** 软修剪 TTL：超过该年龄的工具结果只保留头尾 */
const SOFT_TTL_MS = 5 * 60 * 1000
/** 硬清空 TTL：超过该年龄的工具结果整体替换为过期占位符 */
const HARD_TTL_MS = 10 * 60 * 1000
/** 软修剪保留的头/尾字符数 */
const KEEP_HEAD_TAIL = 1500

// ── Layer 1: Token 估算 ───────────────────────────────

function countMessageChars(message: ModelMessage): number {
  if (typeof message.content === 'string') return message.content.length
  let chars = 0
  for (const part of message.content) {
    if ('text' in part && typeof part.text === 'string') {
      chars += part.text.length
    } else if ('output' in part) {
      chars += toolResultOutputToText(part.output).length
    } else if ('input' in part) {
      chars += JSON.stringify(part.input)?.length ?? 0
    }
  }
  return chars
}

function countMessagesChars(messages: ModelMessage[]): number {
  let chars = 0
  for (const message of messages) chars += countMessageChars(message)
  return chars
}

/** 粗估 token 数：4 字符/token，×1.2 安全系数（中文实际约 1~1.5 字符/token） */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  return Math.ceil((countMessagesChars(messages) / 4) * 1.2)
}

/**
 * 上下文占用追踪器：API 真实用量锚定 + 字符增量。
 *
 * 每步 LLM 回包后 updateFromAPI(promptTokens) 锚定（该值含 system + 工具 schema，
 * 与 estimateMessageTokens 的"纯消息"口径不同）；消息数组变更（追加/压缩）后
 * 用 addMessages / replaceMessages 增量对账，避免每次全量重算。
 */
export class TokenTracker {
  private lastPreciseCount = 0
  private pendingChars = 0

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens
    this.pendingChars = 0
  }

  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message)
  }

  addMessages(messages: ModelMessage[]): void {
    for (const message of messages) this.addMessage(message)
  }

  /** 消息数组被替换（压缩/修剪）后对账：按前后字符差调整增量 */
  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before)
  }

  get estimatedTokens(): number {
    return Math.max(0, this.lastPreciseCount + Math.ceil(this.pendingChars / 4))
  }

  /** needsAction = 占窗口 75%+：summarize（50% 阈值）跑完后仍偏高的硬警告 */
  get status(): { tokens: number; percent: number; needsAction: boolean } {
    const tokens = this.estimatedTokens
    const percent = Math.round((tokens / CONTEXT_WINDOW) * 100)
    return { tokens, percent, needsAction: percent >= 75 }
  }
}

/** 错误输出判定：只认结构化类型，不做文本正则（避免"读取了含 error 字样的文件"这类误报） */
function isErrorOutput(output: ToolResultPart['output']): boolean {
  return output.type === 'error-text' || output.type === 'error-json'
}

// ── UIMessage → ModelMessage 转换（带时间戳） ──────────

/**
 * UIMessage[] → ModelMessage[]，同时产出与 ModelMessage 下标对齐的时间戳数组。
 * 逐条转换以保证下标对应关系（批量转换不保证 1:1：含工具调用的 assistant 消息
 * 会展开为 assistant + tool 两条）。时间戳取 DB 行（服务端时钟），缺失时视为刚产生。
 */
export async function buildTimestampedMessages(
  uiMessages: UIMessage[],
  createdAtById: ReadonlyMap<string, Date>,
): Promise<{ messages: ModelMessage[]; timestamps: number[] }> {
  const messages: ModelMessage[] = []
  const timestamps: number[] = []
  for (const ui of uiMessages) {
    const ts = createdAtById.get(ui.id)?.getTime() ?? Date.now()
    const converted = await convertToModelMessages([ui])
    for (let i = 0; i < converted.length; i++) timestamps.push(ts)
    messages.push(...converted)
  }
  return { messages, timestamps }
}

// ── Layer 2: 工具结果截断 ─────────────────────────────

export interface TruncationResult {
  messages: ModelMessage[]
  /** Pass 1：超长结果被截断的数量 */
  truncated: number
  /** Pass 2：为满足总预算被清除的数量 */
  compacted: number
}

export function truncateToolResults(messages: ModelMessage[]): TruncationResult {
  let truncated = 0
  let compacted = 0

  // Pass 1：单结果截断（头 60% / 尾 40%，复用执行层的截断实现与格式）
  let result = messages.map((msg) => {
    if (msg.role !== 'tool') return msg
    const newContent = msg.content.map((part) => {
      if (!('output' in part) || isErrorOutput(part.output)) return part
      const text = toolResultOutputToText(part.output)
      if (text.length <= MAX_SINGLE_RESULT_CHARS) return part
      truncated++
      return {
        ...part,
        output: textToolResultOutput(truncateResult(text, MAX_SINGLE_RESULT_CHARS)),
      }
    })
    return { ...msg, content: newContent }
  })

  // Pass 2：总预算强制——从最老的工具结果开始清（错误结果豁免，最近的不豁免：硬顶必须能压下来）
  let totalChars = countMessagesChars(result)
  result = result.map((msg) => {
    if (totalChars <= CONTEXT_BUDGET_CHARS || msg.role !== 'tool') return msg
    const outputs = msg.content.filter((part): part is ToolResultPart => 'output' in part)
    if (outputs.length > 0 && outputs.every((part) => isErrorOutput(part.output))) return msg

    const oldSize = countMessageChars(msg)
    const compactedMsg: ModelMessage = {
      ...msg,
      content: msg.content.map((part) =>
        'output' in part && !isErrorOutput(part.output)
          ? { ...part, output: textToolResultOutput('[compacted: 为腾出上下文预算已清除]') }
          : part,
      ),
    }
    totalChars += countMessageChars(compactedMsg) - oldSize
    compacted++
    return compactedMsg
  })

  return { messages: result, truncated, compacted }
}

// ── Layer 3: TTL 修剪 ─────────────────────────────────

export interface PruneResult {
  messages: ModelMessage[]
  softPruned: number
  hardPruned: number
}

export function ttlPrune(messages: ModelMessage[], timestamps: number[]): PruneResult {
  // 下标与时间戳未对齐说明映射出错：宁可漏修不可错修，整体放弃
  if (timestamps.length !== messages.length) {
    return { messages, softPruned: 0, hardPruned: 0 }
  }

  // 最近 N 个工具结果豁免：与 microcompact 的保留窗口一致（模型可能仍在引用）
  const toolIndices: number[] = []
  for (const [i, msg] of messages.entries()) {
    if (msg.role === 'tool') toolIndices.push(i)
  }
  const exempt = new Set(toolIndices.slice(-TTL_EXEMPT_RECENT))

  const now = Date.now()
  let softPruned = 0
  let hardPruned = 0

  const result = messages.map((msg, idx) => {
    if (msg.role !== 'tool' || exempt.has(idx)) return msg
    const ts = timestamps[idx]
    if (ts === undefined) return msg
    const age = now - ts
    if (age < SOFT_TTL_MS) return msg

    // 硬清空：过期结果整体替换为占位符（错误输出同样清，过期报错无保留价值）
    if (age >= HARD_TTL_MS) {
      hardPruned++
      return {
        ...msg,
        content: msg.content.map((part) =>
          'output' in part
            ? {
                ...part,
                output: textToolResultOutput('[tool result expired: 结果已过期，如需请重新执行]'),
              }
            : part,
        ),
      }
    }

    // 软修剪：保留头尾、丢弃中间（错误输出豁免）
    const newContent = msg.content.map((part) => {
      if (!('output' in part) || isErrorOutput(part.output)) return part
      const text = toolResultOutputToText(part.output)
      if (text.length <= KEEP_HEAD_TAIL * 2) return part
      softPruned++
      const head = text.slice(0, KEEP_HEAD_TAIL)
      const tail = text.slice(-KEEP_HEAD_TAIL)
      return {
        ...part,
        output: textToolResultOutput(
          `${head}\n\n[soft pruned: 已修剪 ${text.length - KEEP_HEAD_TAIL * 2} 字符` +
            `（内容超过 ${Math.round(SOFT_TTL_MS / 60000)} 分钟）]\n\n${tail}`,
        ),
      }
    })
    return { ...msg, content: newContent }
  })

  return { messages: result, softPruned, hardPruned }
}

// ── 组合入口 ──────────────────────────────────────────

export interface DefenseResult {
  messages: ModelMessage[]
  truncated: number
  compacted: number
  softPruned: number
  hardPruned: number
}

/** 三层防线组合：截断 → TTL 修剪（是否需要 LLM 摘要由 summarize 内部自行判断） */
export function applyDefense(messages: ModelMessage[], timestamps: number[]): DefenseResult {
  const trunc = truncateToolResults(messages)
  const prune = ttlPrune(trunc.messages, timestamps)
  return {
    messages: prune.messages,
    truncated: trunc.truncated,
    compacted: trunc.compacted,
    softPruned: prune.softPruned,
    hardPruned: prune.hardPruned,
  }
}
