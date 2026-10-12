import type { LanguageModel, ModelMessage, ToolSet, UIMessageStreamWriter } from 'ai'
import { streamText } from 'ai'
import { createLoopGuard } from './loop-guard'

/** 防死循环上限 */
const MAX_STEPS = 15

/**
 * 手动驱动的工具循环（不用 stopWhen，完全掌控每一步）。
 *
 * 每轮：streamText 只跑一步 → 遍历 fullStream 转发给前端 →
 *   有工具调用：把本步消息（assistant 工具调用 + tool 执行结果）追加进上下文，继续下一轮；
 *   没有工具调用：模型已给出最终文本回复，循环结束。
 *
 * 内置循环检测（loop-guard）：
 *   warning → 本步结束后注入一条 [系统提醒]，引导模型换思路；
 *   critical → 立即终止循环，向前端补发终止提示。
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
  // 循环检测器：请求级实例，与本次 agentLoop 生命周期一致
  const guard = createLoopGuard()
  let steps = 0
  let finishedByReply = false
  let trippedByGuard = false

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
    let shouldBreak = false
    // 一步内可能并行多个工具调用：按 toolCallId 记录签名，结果回填不会错位
    const pendingCalls = new Map<string, { name: string; input: unknown }>()
    // warning 提醒暂存：必须等本步消息追加完再注入，否则会插到 assistant/tool 消息之前。
    // 按签名去重：同一循环源只提醒一次，避免连续注入多条近似内容
    const reminders = new Map<string, string>()
    // 工具输出可能包含敏感内容，日志只保留截断片段
    const logTrunc = (v: unknown) => {
      const s = JSON.stringify(v)
      return s.length > 120 ? `${s.slice(0, 120)}…` : s
    }

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
        case 'tool-call': {
          hasToolCall = true
          pendingCalls.set(part.toolCallId, { name: part.toolName, input: part.input })
          console.log(`  [调用: ${part.toolName}(${logTrunc(part.input)})]`)

          // 先检测（基于历史，不含本次），再记录本次调用
          const detection = guard.detect(part.toolName, part.input)
          if (detection.stuck) {
            console.log(`  ${detection.message}`)
            if (detection.level === 'critical') {
              shouldBreak = true
            } else {
              // 同一签名只提醒一次
              reminders.set(`${detection.detector}:${detection.count}`, detection.message)
            }
          }
          guard.recordCall(part.toolName, part.input)
          writer.write({
            type: 'tool-input-available',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
          break
        }
        case 'tool-result': {
          const call = pendingCalls.get(part.toolCallId)
          if (call) {
            console.log(`  [结果: ${logTrunc(part.output)}]`)
            guard.recordResult(call.name, call.input, part.output)
          }
          writer.write({
            type: 'tool-output-available',
            toolCallId: part.toolCallId,
            output: part.output,
          })
          break
        }
        case 'tool-error': {
          // 工具 execute 抛异常：转发给前端，同时继续循环让模型看到错误并自行处理
          hasToolCall = true
          const call = pendingCalls.get(part.toolCallId)
          if (call) {
            guard.recordResult(call.name, call.input, {
              error: part.error instanceof Error ? part.error.message : String(part.error),
            })
          }
          writer.write({
            type: 'tool-output-error',
            toolCallId: part.toolCallId,
            errorText: part.error instanceof Error ? part.error.message : String(part.error),
          })
          break
        }
        case 'error':
          throw part.error // 由 createUIMessageStream 的 onError 统一处理
      }
    }

    // 循环检测熔断 → 跳出整个 agent 循环
    if (shouldBreak) {
      trippedByGuard = true
      break
    }

    // 本步没有工具调用 → 模型直接给出文本回复，结束循环
    if (!hasToolCall) {
      finishedByReply = true
      break
    }

    // 有工具调用 → 把本步消息追加进上下文，下一轮模型会看到工具执行结果
    messages.push(...(await result.response).messages)

    // warning 提醒注入到工具结果之后，保持消息顺序（user 提醒位于 assistant/tool 之后）
    for (const message of reminders.values()) {
      messages.push({
        role: 'user' as const,
        content: `[系统提醒] ${message}。请换一个思路解决问题，不要重复同样的操作。`,
      })
    }
  }

  // 异常收尾时补提示，避免前端静默结束
  if (trippedByGuard || !finishedByReply) {
    const id = trippedByGuard ? 'loop-guard-tripped' : 'step-limit'
    const delta = trippedByGuard
      ? '（检测到无进展的重复操作，已强制终止。）'
      : '（已达工具调用步数上限，请继续提问。）'
    writer.write({ type: 'text-start', id })
    writer.write({ type: 'text-delta', id, delta })
    writer.write({ type: 'text-end', id })
  }
}
