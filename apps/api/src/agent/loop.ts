import type { LanguageModel, ModelMessage, ToolSet, UIMessageStreamWriter } from 'ai'
import { streamText } from 'ai'
import { microcompact, summarize } from '../context/compressor'
import type { TokenTracker } from '../context/defense'
import { normalizeUsage, type UsageTracker } from '../usage/tracker'
import { createLoopGuard } from './loop-detection'
import { calculateDelay, isRetryable, retryAfterMs, sleep } from './retry'

/** 防死循环上限 */
const MAX_STEPS = 15
/** 每步 LLM 调用的最大重试次数（429/5xx/网络错误等可重试错误） */
const MAX_RETRIES = 3
/** 单次请求的 Token 预算上限（所有步骤累计） */
export const TOKEN_BUDGET = 200_000

/**
 * Token 预算：由调用方持有（跨轮持续累计），agentLoop 每步成功后累加用量，
 * 超限时终止循环，防止长对话/工具链无节制烧 token。
 */
export interface BudgetState {
  used: number
  limit: number
}

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
 * 内置步骤级重试（retry）：429/5xx/网络错误等按指数退避重试（最多 3 次），
 * 400 等不可重试错误直接抛出；已向客户端转发过内容的步骤不重试（避免重复输出）。
 *
 * 内置步后压缩（compaction）：每步消息追加后执行 microcompact + summarize，
 * 防止单次请求内工具结果累积撑爆上下文窗口。
 *
 * @param writer UI 消息流写入器，chunk 实时转发给前端
 * @param abortSignal 客户端断开/取消时中止循环，停止后续 LLM 调用
 * @param budget 可选 Token 预算（调用方持有），耗尽时终止循环
 * @param tracker 可选上下文占用追踪（调用方持有）：每步用 API 真实 promptTokens
 *   锚定、消息追加/压缩后增量对账。与 budget 语义不同——budget 计跨步累计消耗，
 *   tracker 计当前窗口占用（含 system + 工具 schema）。
 * @param usageTracker 可选成本追踪（调用方持有）：每步用 API 真实 usage
 *   规范化成四类 token（input / output / cache 读 / cache 写）后按价格表计价累计。
 * @param chatId 可选会话 id：写入成本记录，供按会话查询用量（/api/usage?chatId=）
 */
export async function agentLoop(
  model: LanguageModel,
  tools: ToolSet,
  messages: ModelMessage[],
  system: string,
  writer: UIMessageStreamWriter,
  abortSignal?: AbortSignal,
  budget?: BudgetState,
  tracker?: TokenTracker,
  usageTracker?: UsageTracker,
  chatId?: string,
): Promise<void> {
  // LanguageModel 联合类型含字符串形式（GlobalProviderModelId），两种都取得到 id
  const modelId = typeof model === 'string' ? model : model.modelId
  // 循环检测器：请求级实例，与本次 agentLoop 生命周期一致
  const guard = createLoopGuard()
  let steps = 0
  let finishedByReply = false
  let trippedByGuard = false
  let stoppedByBudget = false

  while (steps < MAX_STEPS) {
    steps++

    let hasToolCall = false
    let shouldBreak = false
    // 本步是否已向客户端转发过内容——转发过就不能重试：
    // 重试会以新的消息 id 重新发送，前端会出现重复的文本/工具卡片
    let forwarded = false
    let stepMessages: ModelMessage[] = []
    // warning 提醒暂存：必须等本步消息追加完再注入，否则会插到 assistant/tool 消息之前。
    // 按签名去重：同一循环源只提醒一次，避免连续注入多条近似内容
    const reminders = new Map<string, string>()
    // 步骤开始前的检测历史快照：重试时回滚，避免失败尝试的调用记录污染循环检测
    const guardMark = guard.snapshot()

    // 步骤级重试：包裹整个流消费过程
    for (let attempt = 1; ; attempt++) {
      // 一步内可能并行多个工具调用：按 toolCallId 记录签名，结果回填不会错位
      const pendingCalls = new Map<string, { name: string; input: unknown }>()
      // 工具输出可能包含敏感内容，日志只保留截断片段
      const logTrunc = (v: unknown) => {
        const s = JSON.stringify(v)
        return s.length > 120 ? `${s.slice(0, 120)}…` : s
      }
      // 统一经 send 转发，同步标记 forwarded
      const send: UIMessageStreamWriter['write'] = (chunk) => {
        forwarded = true
        writer.write(chunk)
      }

      try {
        const result = streamText({
          model,
          system,
          messages,
          tools,
          abortSignal,
          // 关掉 SDK 内置重试（默认 2 次、2s 起步）：由本循环统一做分类重试
          maxRetries: 0,
          // 不设 stopWhen：单次 streamText 默认只执行一步
        })

        for await (const part of result.fullStream) {
          // 注意：fullStream 文本增量字段是 text，UI chunk 是 delta
          switch (part.type) {
            case 'text-start':
              send({ type: 'text-start', id: part.id })
              break
            case 'text-delta':
              send({ type: 'text-delta', id: part.id, delta: part.text })
              break
            case 'text-end':
              send({ type: 'text-end', id: part.id })
              break
            case 'reasoning-start':
              send({ type: 'reasoning-start', id: part.id })
              break
            case 'reasoning-delta':
              send({
                type: 'reasoning-delta',
                id: part.id,
                delta: part.text,
              })
              break
            case 'reasoning-end':
              send({ type: 'reasoning-end', id: part.id })
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
              send({
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
              send({
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
              send({
                type: 'tool-output-error',
                toolCallId: part.toolCallId,
                errorText: part.error instanceof Error ? part.error.message : String(part.error),
              })
              break
            }
            case 'error':
              throw part.error // 交给本步骤的重试逻辑分类处理
          }
        }

        stepMessages = (await result.response).messages
        // result.usage 为 SDK 拍平后的形状；provider 未上报时为 undefined
        const usage = await result.usage
        if (budget) {
          budget.used += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        }
        // 成本追踪：四类 token 分别计价（cache 命中折扣各模型不同，见 PRICE_TABLE）
        if (usageTracker && usage) {
          usageTracker.record(modelId, normalizeUsage(usage), chatId)
        }
        // 锚定：API 上报的 promptTokens 对应本步发送时的 messages（含 system + 工具 schema）
        if (tracker && usage.inputTokens != null && usage.inputTokens > 0) {
          tracker.updateFromAPI(usage.inputTokens)
        }
        break // 本步成功，跳出重试循环
      } catch (error) {
        // 三个不重试的条件：已转发过内容 / 重试次数用尽 / 错误类型不可重试（如 400）
        if (forwarded || attempt > MAX_RETRIES || !isRetryable(error)) throw error

        // Retry-After 优先（服务端建议，内部有 30s 封顶），否则指数退避 + 抖动
        const delay = retryAfterMs(error) ?? calculateDelay(attempt)
        console.log(
          `  [重试] Step ${steps} 第 ${attempt}/${MAX_RETRIES} 次失败` +
            `（${error instanceof Error ? error.message : String(error)}），${delay}ms 后重试...`,
        )

        // 回滚本步状态与循环检测历史：失败尝试的记录不能带进下一次尝试。
        // guard.restore 与 reminders.clear 在 forwarded 守卫下均为空操作，
        // 保留理由见 loop-guard.ts snapshot 的注释（未来缓冲转发模式的事务边界）
        guard.restore(guardMark)
        hasToolCall = false
        shouldBreak = false
        reminders.clear()
        // 等待期间客户端断开 → sleep 立即 reject，终止重试
        await sleep(delay, abortSignal)
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

    // Token 预算耗尽 → 不再发起下一步 LLM 调用（本步已是最终回复时不会走到这里）
    if (budget) {
      const pct = Math.round((budget.used / budget.limit) * 100)
      console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%)`)
      if (budget.used > budget.limit) {
        stoppedByBudget = true
        break
      }
    }

    // 有工具调用 → 把本步消息追加进上下文，下一轮模型会看到工具执行结果
    messages.push(...stepMessages)
    tracker?.addMessages(stepMessages)

    // warning 提醒注入到工具结果之后，保持消息顺序（user 提醒位于 assistant/tool 之后）
    for (const message of reminders.values()) {
      const reminder: ModelMessage = {
        role: 'user',
        content: `[系统提醒] ${message}。请换一个思路解决问题，不要重复同样的操作。`,
      }
      messages.push(reminder)
      tracker?.addMessage(reminder)
    }

    // 步后压缩：工具结果随步骤持续累积，防止长工具链撑爆上下文窗口
    // （budget 计的是累计消耗，拦不住单步上下文超窗的 API 400）。
    // microcompact 无额外成本；summarize 内部有 token 阈值守卫，低于阈值时为空操作。
    // 上一次的摘要已作为 user 消息留在 messages 中，再次摘要会自然合并，无需外部状态
    const beforeCompaction = messages
    messages = microcompact(messages).messages
    const stepCompacted = await summarize(model, messages, abortSignal)
    messages = stepCompacted.messages
    // 压缩改写了消息数组，tracker 按前后字符差对账
    tracker?.replaceMessages(beforeCompaction, messages)
    if (stepCompacted.compressedCount > 0) {
      console.log(`  [压缩] 摘要替换 ${stepCompacted.compressedCount} 条消息`)
    }
    // summarize（50% 阈值）跑完后占用仍达 75%+：上下文增长快于压缩能力，提示观测
    if (tracker?.status.needsAction) {
      const { tokens, percent } = tracker.status
      console.warn(`  [Token] 上下文占用 ~${tokens} (${percent}%)，压缩后仍然偏高`)
    }
  }

  // 异常收尾时补提示，避免前端静默结束
  if (trippedByGuard || stoppedByBudget || !finishedByReply) {
    const id = trippedByGuard
      ? 'loop-guard-tripped'
      : stoppedByBudget
        ? 'token-budget-exhausted'
        : 'step-limit'
    const delta = trippedByGuard
      ? '（检测到无进展的重复操作，已强制终止。）'
      : stoppedByBudget
        ? '（已达到本次回复的 Token 预算上限，如有需要请继续提问。）'
        : '（已达工具调用步数上限，请继续提问。）'
    writer.write({ type: 'text-start', id })
    writer.write({ type: 'text-delta', id, delta })
    writer.write({ type: 'text-end', id })
  }
}
