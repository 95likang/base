/**
 * 上下文压缩：发送给 LLM 前在内存中缩小消息（DB 始终保存完整历史，不落库）。
 *
 * 两层策略：
 * - Layer 1 microcompact：确定性规则，把较早的工具结果替换为占位符（最近 3 个保留原文）。
 *   便宜、安全、无信息结构变化，每次请求都执行。
 * - Layer 2 summarize：token 估算超过阈值时，用 LLM 把最老的一段对话压缩成结构化摘要，
 *   摘要以 user 消息注入，最近对话原样保留。有损、有额外 LLM 成本，按需触发。
 */
import { generateText, type LanguageModel, type ModelMessage } from 'ai'
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output'

/** 可安全清空结果的工具（结果可由模型重新读取获取，丢失无碍） */
const CLEARABLE_TOOLS = new Set([
  'read_file',
  'bash',
  'grep',
  'glob',
  'list_directory',
  'edit_file',
  'write_file',
])
/** 最近 N 个工具结果保留原文，其余清空 */
const KEEP_RECENT_TOOL_RESULTS = 3
/** token 估算超过该值才触发 LLM 摘要（上下文窗口 200k，留一半余量给工具循环增长） */
const CONTEXT_TOKEN_THRESHOLD = 100_000
/** 摘要时保留的最近消息条数（边界会再向前对齐到 user 消息，保证回合完整） */
const KEEP_RECENT_MESSAGES = 6

/** 粗估 token 数：中英混合约 4 字符 / token */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          chars += part.text.length
        } else if ('output' in part) {
          chars += toolResultOutputToText(part.output).length
        }
      }
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Layer 1：清空较早的可清空工具结果。
 * 不改消息结构（tool-call / tool-result 配对保持完整），只替换 output 内容。
 */
export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[]
  cleared: number
} {
  const toolResultIndices: number[] = []
  for (const [i, msg] of messages.entries()) {
    if (msg.role === 'tool') toolResultIndices.push(i)
  }
  const toClear = new Set(
    toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS)),
  )

  let cleared = 0
  const result = messages.map((msg, idx) => {
    if (!toClear.has(idx) || msg.role !== 'tool') return msg
    const first = msg.content[0]
    if (!first || !('toolName' in first) || !CLEARABLE_TOOLS.has(first.toolName)) return msg

    cleared++
    return {
      ...msg,
      content: msg.content.map((part) =>
        'output' in part
          ? { ...part, output: textToolResultOutput('[tool result cleared]') }
          : part,
      ),
    }
  })

  return { messages: result, cleared }
}

const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`

interface CompactionResult {
  messages: ModelMessage[]
  compressedCount: number
}

/**
 * Layer 2：token 超阈值时，把最老的一段对话（对齐到完整回合边界）压缩为 LLM 摘要。
 * 摘要以 user 消息注入开头，最近 KEEP_RECENT_MESSAGES 条（对齐后）原样保留。
 * LLM 摘要失败时降级返回原消息，不影响主流程。
 */
export async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
): Promise<CompactionResult> {
  const tokenEstimate = estimateTokens(messages)
  if (tokenEstimate < CONTEXT_TOKEN_THRESHOLD || messages.length <= KEEP_RECENT_MESSAGES) {
    return { messages, compressedCount: 0 }
  }

  // 切分点向前对齐到 user 消息：保证两侧都是完整回合，
  // 不会把 assistant(tool-call) 与对应的 tool(result) 切开（切开会直接被 API 拒绝）
  let alignedIdx = messages.length - KEEP_RECENT_MESSAGES
  while (alignedIdx > 0 && messages[alignedIdx]?.role !== 'user') {
    alignedIdx--
  }
  if (alignedIdx === 0) {
    return { messages, compressedCount: 0 }
  }

  const toCompress = messages.slice(0, alignedIdx)
  const toKeep = messages.slice(alignedIdx)

  const conversationText = toCompress
    .map((msg) => {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .map((part) =>
                'text' in part
                  ? part.text
                  : 'output' in part
                    ? toolResultOutputToText(part.output)
                    : 'input' in part
                      ? `${part.toolName}(${JSON.stringify(part.input)})`
                      : '',
              )
              .join('')
      return content ? `**${msg.role}**: ${content}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

  if (!conversationText.trim()) {
    return { messages, compressedCount: 0 }
  }

  try {
    const { text: summary } = await generateText({
      model,
      system: COMPRESS_PROMPT,
      prompt: conversationText,
      abortSignal,
    })

    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
    }

    return {
      messages: [summaryMessage, ...toKeep],
      compressedCount: toCompress.length,
    }
  } catch (err) {
    console.error('[Compaction] LLM 摘要失败:', err)
    return { messages, compressedCount: 0 }
  }
}
