import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelMessage } from 'ai'
import type { StepUsage } from '../usage/tracker'
import { redactSensitive } from './mask'

type TraceStatus = 'completed' | 'failed' | 'cancelled'

interface TraceOptions {
  /** 相对路径以进程 cwd 为基准；默认 .traces */
  directory?: string
  sessionId: string
  model: string
}

interface StepStartedInput {
  step: number
  system: string
  messages: ModelMessage[]
}

interface StepCompletedInput {
  step: number
  text: string
  outputMessages: ModelMessage[]
  usage: StepUsage
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'default'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 本地 Trace 记录器：一次 Agent 任务一个 JSONL 文件，逐事件追加。
 *
 * 每个 Step 记录开始前的上下文快照（system + messages）和结束后的输出
 * （新增消息 + 文本 + usage + 耗时），失败重试插入 step_attempt_failed，
 * 任务头尾分别是 trace_started / trace_finished。
 */
export class LocalTraceRecorder {
  readonly traceId: string
  readonly filePath: string
  private readonly startedAt = Date.now()
  private stepStartedAt = 0
  private writeFailed = false

  private constructor(options: TraceOptions) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.traceId = `${safeName(options.sessionId)}-${stamp}`
    this.filePath = join(options.directory ?? '.traces', `${this.traceId}.jsonl`)
  }

  static async start(options: TraceOptions): Promise<LocalTraceRecorder> {
    const recorder = new LocalTraceRecorder(options)
    await mkdir(dirname(recorder.filePath), { recursive: true })
    await recorder.write({
      type: 'trace_started',
      traceId: recorder.traceId,
      sessionId: options.sessionId,
      model: options.model,
      timestamp: new Date().toISOString(),
    })
    return recorder
  }

  async recordStepStarted(input: StepStartedInput): Promise<void> {
    this.stepStartedAt = Date.now()
    await this.write({
      type: 'step_started',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      context: redactSensitive({ system: input.system, messages: input.messages }),
    })
  }

  async recordAttemptError(step: number, attempt: number, error: unknown): Promise<void> {
    await this.write({
      type: 'step_attempt_failed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step,
      attempt,
      error: errorMessage(error),
    })
  }

  async recordStepCompleted(input: StepCompletedInput): Promise<void> {
    await this.write({
      type: 'step_completed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      durationMs: this.stepStartedAt === 0 ? 0 : Date.now() - this.stepStartedAt,
      output: redactSensitive({ text: input.text, messages: input.outputMessages }),
      usage: input.usage,
    })
  }

  async finish(status: TraceStatus, error?: unknown): Promise<void> {
    await this.write({
      type: 'trace_finished',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      status,
      durationMs: Date.now() - this.startedAt,
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    })
  }

  private async write(event: Record<string, unknown>): Promise<void> {
    if (this.writeFailed) return
    try {
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8')
    } catch (error) {
      // Trace 是观测手段，写失败不能影响主流程：停掉后续写入并提示一次
      this.writeFailed = true
      console.warn(`  [Trace] 写入失败，已停止记录: ${errorMessage(error)}`)
    }
  }
}

/** 从 step_completed 的输出消息里提取本步调用过的工具名（去重保序） */
function toolNames(output: unknown): string[] {
  if (!output || typeof output !== 'object') return []
  const messages = (output as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []

  const names = new Set<string>()
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const { type, toolName } = part as { type?: unknown; toolName?: unknown }
      if (type === 'tool-call' && typeof toolName === 'string') names.add(toolName)
    }
  }
  return [...names]
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function formatMs(value: unknown): string {
  return typeof value === 'number' ? `${value}ms` : '-'
}

/**
 * 最小复盘视图：逐行解析事件，只提取 Step、耗时、token 和工具名。
 * 原始 JSONL 仍是最完整的证据，需要细节时直接看文件。
 */
export async function inspectTrace(filePath: string): Promise<string> {
  const raw = await readFile(filePath, 'utf8')
  const events: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // 进程中途退出可能留下半行：跳过残行，前面的事件仍然有效
    }
  }

  if (events.length === 0) return `(空 Trace: ${filePath})`

  const started = events.find((event) => event.type === 'trace_started')
  const finished = events.find((event) => event.type === 'trace_finished')
  const steps = events.filter((event) => event.type === 'step_completed')
  const failures = events.filter((event) => event.type === 'step_attempt_failed')

  let inputTokens = 0
  let outputTokens = 0
  for (const step of steps) {
    const usage = step.usage as Partial<StepUsage> | undefined
    inputTokens += numberOr0(usage?.inputTokens)
    outputTokens += numberOr0(usage?.outputTokens)
  }

  const lines = [
    `Trace   ${String(started?.traceId ?? filePath)}`,
    `模型    ${String(started?.model ?? '-')}`,
    `会话    ${String(started?.sessionId ?? '-')}`,
    `状态    ${String(finished?.status ?? '未完成（缺少 trace_finished）')}`,
    `耗时    ${formatMs(finished?.durationMs)}`,
    `Token   input ${inputTokens} / output ${outputTokens}`,
    '',
  ]

  for (const step of steps) {
    const usage = step.usage as Partial<StepUsage> | undefined
    const tools = toolNames(step.output)
    lines.push(
      `Step ${String(step.step)}  ${formatMs(step.durationMs)}` +
        `  in ${numberOr0(usage?.inputTokens)} / out ${numberOr0(usage?.outputTokens)}` +
        (tools.length > 0 ? `  工具: ${tools.join(', ')}` : ''),
    )
  }

  for (const failure of failures) {
    lines.push(
      `Step ${String(failure.step)} 尝试 ${String(failure.attempt)} 失败: ${String(failure.error)}`,
    )
  }

  return lines.join('\n')
}
