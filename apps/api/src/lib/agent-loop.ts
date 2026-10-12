import type { LanguageModel, ModelMessage, ToolSet, UIMessageStreamWriter } from 'ai'
import { streamText } from 'ai'

/** 防死循环上限 */
const MAX_STEPS = 5

/**
 * 手动驱动的工具循环（不用 stopWhen，完全掌控每一步）。
 *
 * 每轮：streamText 只跑一步 → 遍历 fullStream 转发给前端 →
 *   有工具调用：把本步消息（assistant 工具调用 + tool 执行结果）追加进上下文，继续下一轮；
 *   没有工具调用：模型已给出最终文本回复，循环结束。
 *
 * @param writer UI 消息流写入器，chunk 实时转发给前端
 * @param abortSignal 客户端断开/取消时中止循环，停止后续 LLM 调用
 */
export async function agentLoop(
  model: LanguageModel,
  tools: ToolSet,
  messages: ModelMessage[],
  system: string,
  writer: UIMessageStreamWriter,
  abortSignal?: AbortSignal,
): Promise<void> {
  let steps = 0
  let finishedByReply = false

  while (steps < MAX_STEPS) {
    steps++

    const result = streamText({
      model,
      system,
      messages,
      tools,
      abortSignal,
      // 不设 stopWhen：单次 streamText 默认只执行一步
    })

    let hasToolCall = false

    for await (const part of result.fullStream) {
      // 注意：fullStream 文本增量字段是 text，UI chunk 是 delta
      switch (part.type) {
        case 'text-start':
          writer.write({ type: 'text-start', id: part.id })
          break
        case 'text-delta':
          writer.write({ type: 'text-delta', id: part.id, delta: part.text })
          break
        case 'text-end':
          writer.write({ type: 'text-end', id: part.id })
          break
        case 'reasoning-start':
          writer.write({ type: 'reasoning-start', id: part.id })
          break
        case 'reasoning-delta':
          writer.write({
            type: 'reasoning-delta',
            id: part.id,
            delta: part.text,
          })
          break
        case 'reasoning-end':
          writer.write({ type: 'reasoning-end', id: part.id })
          break
        case 'tool-call':
          hasToolCall = true
          writer.write({
            type: 'tool-input-available',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
          break
        case 'tool-result':
          writer.write({
            type: 'tool-output-available',
            toolCallId: part.toolCallId,
            output: part.output,
          })
          break
        case 'tool-error':
          // 工具 execute 抛异常：转发给前端，同时继续循环让模型看到错误并自行处理
          hasToolCall = true
          writer.write({
            type: 'tool-output-error',
            toolCallId: part.toolCallId,
            errorText: part.error instanceof Error ? part.error.message : String(part.error),
          })
          break
        case 'error':
          throw part.error // 由 createUIMessageStream 的 onError 统一处理
      }
    }

    // 本步没有工具调用 → 模型直接给出文本回复，结束循环
    if (!hasToolCall) {
      finishedByReply = true
      break
    }

    // 有工具调用 → 把本步消息追加进上下文，下一轮模型会看到工具执行结果
    messages.push(...(await result.response).messages)
  }

  // 步数耗尽而非模型主动收尾：补一条提示，避免前端静默结束
  if (!finishedByReply) {
    const id = 'step-limit'
    writer.write({ type: 'text-start', id })
    writer.write({
      type: 'text-delta',
      id,
      delta: '（已达工具调用步数上限，请继续提问。）',
    })
    writer.write({ type: 'text-end', id })
  }
}
