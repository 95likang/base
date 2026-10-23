import type { ModelMessage } from 'ai'
import { streamText } from 'ai'
import type { BudgetState } from '../agent/loop'
import { anthropic } from '../agent/model'
import { buildRuntimeSystem } from '../context/runtime-prompt'
import type { ToolRegistry } from '../tools/registry'
import { createToolSearchTool } from '../tools/tool-search'
import { usageLog } from '../usage'
import { normalizeUsage } from '../usage/tracker'
import type { SubAgentRegistry } from './registry'
import type { SpawnRequest } from './types'

export interface SpawnContext {
  /** 父 Agent 的请求级注册表：子 Agent 从这里 fork 出独立锁状态 */
  registry: ToolRegistry
  agentRegistry: SubAgentRegistry
  currentDepth: number
  /** 父请求的取消信号：客户端断开时子 Agent 同步停止 */
  signal?: AbortSignal
  /** 父循环的 token 预算：子 Agent 消耗直接累加进去，受同一个上限约束 */
  budget?: BudgetState
}

/** 子 Agent 的单次执行步数上限（最后一步强制输出文字总结） */
const MAX_STEPS = 30
/** 没有父预算时的兜底上限；有父预算时统一由父预算约束，避免单子上限过早打断探索 */
const FALLBACK_TOKEN_CAP = 150_000

/** 从源头阻止递归派生（深度检查只是兜底） */
const EXCLUDED_TOOLS = new Set(['spawn_agent'])

const SUB_AGENT_SYSTEM_SUFFIX =
  '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
  '\n需要获取多个独立信息时（读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具。'

const AGENT_COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m']
const RESET = '\x1b[0m'

function agentTag(index: number, runId: string): string {
  const color = AGENT_COLORS[index % AGENT_COLORS.length]
  return `${color}[Agent-${index + 1}:${runId}]${RESET}`
}

/**
 * 取最后一条有文本的 assistant 消息：中间的探索过程全部丢弃，只回传结论。
 * 末尾消息可能只有 tool-call（无 text），需要继续向前找。
 */
function lastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (message.role !== 'assistant') continue
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('')
          : ''
    if (text.trim()) return text
  }
  return ''
}

/**
 * 在独立上下文里执行子 Agent：全新的 messages 数组里只有任务描述，
 * 父 Agent 的历史与工具调用记录一概不可见。
 */
export async function spawnAgent(
  request: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
): Promise<string> {
  const { ok, reason } = ctx.agentRegistry.checkDepth(ctx.currentDepth)
  if (!ok) return `[spawn] 拒绝: ${reason}`
  if (ctx.budget && ctx.budget.used >= ctx.budget.limit) {
    return '[spawn] 拒绝: 本次请求的 token 预算已用尽'
  }

  const runId = ctx.agentRegistry.generateId()
  const tag = agentTag(index, runId)
  const timeout = ctx.agentRegistry.getConfig().defaultTimeout

  // 链式取消：父请求断开或本地超时都走同一个 controller，用 timedOut 区分钟超时与主动取消
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (ctx.signal?.aborted) controller.abort()
  ctx.signal?.addEventListener('abort', onParentAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const messages: ModelMessage[] = [{ role: 'user', content: request.task }]

  // 并发已满时排队等槽位（等待时间也计入超时），不再直接拒绝
  const acquired = await ctx.agentRegistry.acquireSlot(controller.signal)
  if (!acquired) {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', onParentAbort)
    return timedOut ? `[spawn] 等待并发槽位超时 (${timeout / 1000}s)` : '[spawn] 已取消：父请求中断'
  }

  console.log(`  ${tag} 启动: ${request.task.slice(0, 50)}`)
  ctx.agentRegistry.register({
    id: runId,
    task: request.task,
    status: 'running',
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  })
  // 当前步骤已流式产出的文本：中断时作为部分结果回传
  let pendingText = ''

  try {
    // fork：复制工具定义与安全配置，锁状态独立——否则父 Agent 持有独占锁时子 Agent 会死锁。
    // tool_search 必须重新绑定到 fork 后的注册表，否则它会去激活父注册表里的工具。
    const subRegistry = ctx.registry.fork({ exclude: EXCLUDED_TOOLS })
    subRegistry.register(createToolSearchTool(subRegistry))
    const tools = subRegistry.toAISDKFormat()
    const system =
      (await buildRuntimeSystem(subRegistry, 'sub-agent', messages.length)) +
      SUB_AGENT_SYSTEM_SUFFIX
    const model = anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5')
    const modelId = typeof model === 'string' ? model : model.modelId

    let step = 0
    let usedTokens = 0
    let stopReason: 'budget' | 'token-cap' | undefined
    while (step < MAX_STEPS) {
      step++
      const isLastStep = step === MAX_STEPS
      console.log(`  ${tag} Step ${step}/${MAX_STEPS}${isLastStep ? ' (总结)' : ''}`)
      if (isLastStep) {
        messages.push({
          role: 'user',
          content: '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。',
        })
      }

      const result = streamText({
        model,
        system,
        tools,
        toolChoice: isLastStep ? 'none' : 'auto',
        messages,
        // 子 Agent 不向前端转发内容，SDK 重试不会造成重复输出，交给 SDK 兜底 429/5xx
        maxRetries: 2,
        abortSignal: controller.signal,
      })

      let hasToolCall = false
      pendingText = ''
      for await (const part of result.fullStream) {
        if (part.type === 'tool-call') {
          hasToolCall = true
          const preview = JSON.stringify(part.input).slice(0, 80)
          console.log(`  ${tag} 调用 ${part.toolName}(${preview})`)
        } else if (part.type === 'text-delta') {
          pendingText += part.text
        } else if (part.type === 'error') {
          throw part.error
        }
      }

      const response = await result.response
      messages.push(...response.messages)

      // 成本按 'sub-agent' 归类写入 usageLog，并同步计入父循环的预算
      const usage = await result.usage
      if (usage) {
        const stepTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        usedTokens += stepTokens
        if (ctx.budget) ctx.budget.used += stepTokens
        usageLog.record(modelId, normalizeUsage(usage), 'sub-agent')
      }

      if (!hasToolCall) break
      if (ctx.budget) {
        if (ctx.budget.used > ctx.budget.limit) {
          stopReason = 'budget'
          console.log(
            `  ${tag} 父请求预算已用尽 (${ctx.budget.used}/${ctx.budget.limit})，提前结束`,
          )
          break
        }
      } else if (usedTokens > FALLBACK_TOKEN_CAP) {
        stopReason = 'token-cap'
        console.log(`  ${tag} Token ${usedTokens} 超过兜底上限 ${FALLBACK_TOKEN_CAP}，提前结束`)
        break
      }
    }

    // 被动中断时最后一条 assistant 消息往往只是「接下来我要做什么」的叙述，必须明确标记未完成，
    // 否则父 Agent 会把叙述当成结论
    const text = lastAssistantText(messages) || '(无输出)'
    const result = stopReason
      ? `[未完成：${stopReason === 'budget' ? '本次请求 token 预算已用尽' : '达到单次 token 上限'}] 最后进展：${text}`
      : text
    ctx.agentRegistry.complete(runId, result)
    console.log(`  ${tag} 完成 ✓ (${step} 步, ${result.length} 字符)`)
    return result
  } catch (err) {
    const cancelled = ctx.signal?.aborted === true
    const aborted = cancelled || timedOut
    const message = cancelled
      ? '已取消：父请求中断'
      : timedOut
        ? `执行超时 (${timeout / 1000}s)`
        : err instanceof Error
          ? err.message
          : String(err)
    ctx.agentRegistry.fail(runId, message, timedOut ? 'timeout' : 'error')
    console.log(`  ${tag} ${aborted ? '中断' : '失败'} ✗: ${message}`)

    // 中断时保留已产出的文本，不至于完全白跑
    const partial = pendingText.trim() || lastAssistantText(messages)
    if (aborted && partial) return `[部分结果] ${partial}`
    return `[sub-agent 执行失败] ${message}`
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', onParentAbort)
  }
}

/** 并行执行多个子 Agent；超过并发额度的任务在注册表中排队，而不是被拒绝 */
export async function spawnParallel(
  requests: SpawnRequest[],
  ctx: SpawnContext,
): Promise<Array<{ task: string; result: string }>> {
  console.log(`\n  ┌─ 派发 ${requests.length} 个子 Agent 并行执行 ─┐`)
  const results = await Promise.all(
    requests.map(async (request, index) => {
      const result = await spawnAgent(request, ctx, index)
      return { task: request.task, result }
    }),
  )
  console.log(`  └─ 全部完成 (${results.length}/${requests.length}) ─┘\n`)
  return results
}
