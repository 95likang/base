import { getNextCronTime, parseSchedule } from './parser'
import { CronRepository } from './repository'
import type { CronJobConfig, CronJobState, JobPayload, JobSummary, RunLog } from './types'

/** setTimeout 的最大延迟（32 位有符号整数）；超过会被 Node 立即触发 */
const MAX_TIMER_DELAY = 2_147_483_647
/** 进程内任务数量上限：防止模型无限创建任务 */
const MAX_JOBS = 50
/** 固定间隔任务的最小间隔：防止高频任务把系统打满 */
const MIN_INTERVAL_MS = 10_000
/** 执行日志保留天数，启动时清理一次 */
const LOG_RETENTION_DAYS = 30

const QUOTES = [
  '“知之为知之，不知为不知，是知也。” —— 孔子',
  '“学而不思则罔，思而不学则殆。” —— 孔子',
  '“千里之行，始于足下。” —— 老子',
  '“天行健，君子以自强不息。” —— 《周易》',
  '“不积跬步，无以至千里。” —— 荀子',
  '“Stay hungry, stay foolish.” —— Steve Jobs',
  '“The best way to predict the future is to invent it.” —— Alan Kay',
  '“Talk is cheap. Show me the code.” —— Linus Torvalds',
  '“Simplicity is the ultimate sophistication.” —— Leonardo da Vinci',
  '“First, solve the problem. Then, write the code.” —— John Johnson',
]

/** 执行能力由外部注入：CronService 不直接依赖 Agent Loop，便于测试与替换 */
export interface CronExecutor {
  runAgentPrompt: (prompt: string, timeout?: number) => Promise<string>
  notify?: (message: string) => void
}

/**
 * 调度引擎：任务生命周期（加载/调度/执行/失败熔断/持久化）都在这里。
 *
 * - 任务定义与日志持久化在 PostgreSQL（CronRepository）；
 * - 执行器注入：通过 setExecutor 注入 Agent 执行能力；
 * - 连续失败熔断：连续失败 maxRetries 次后自动禁用；
 * - 一次性任务执行完自动删除。
 */
export class CronService {
  private jobs = new Map<string, CronJobState>()
  private readonly repo = new CronRepository()
  private executor?: CronExecutor
  private running = false

  setExecutor(executor: CronExecutor): void {
    this.executor = executor
  }

  /** 从数据库恢复任务与每个任务的上次执行记录；禁用任务也保留，管理页才能重新启用 */
  async load(): Promise<void> {
    await this.repo.pruneLogs(new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000))
    this.jobs.clear()
    for (const config of await this.repo.loadJobs()) {
      const [lastRun] = await this.repo.getRecentLogs(config.id, 1)
      this.jobs.set(config.id, {
        config,
        timerId: null,
        lastRun,
        consecutiveFailures: 0,
        running: false,
      })
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    for (const state of this.jobs.values()) {
      if (state.config.enabled) this.scheduleJob(state)
    }
  }

  stop(): void {
    this.running = false
    for (const state of this.jobs.values()) {
      if (state.timerId) {
        clearTimeout(state.timerId)
        state.timerId = null
      }
    }
  }

  async add(config: CronJobConfig): Promise<void> {
    if (this.jobs.has(config.id)) throw new Error(`任务 ${config.id} 已存在`)
    if (this.jobs.size >= MAX_JOBS) throw new Error(`任务数量已达上限 ${MAX_JOBS}`)
    // 提前解析：表达式非法时立刻失败，而不是等到调度时才在日志里冒出来
    const parsed = parseSchedule(config.schedule)
    if (parsed.type === 'interval' && (parsed.intervalMs ?? 0) < MIN_INTERVAL_MS) {
      throw new Error(`固定间隔不能小于 ${MIN_INTERVAL_MS / 1000}s`)
    }
    await this.repo.saveJob(config)
    const state: CronJobState = {
      config,
      timerId: null,
      consecutiveFailures: 0,
      running: false,
    }
    this.jobs.set(config.id, state)
    if (this.running && config.enabled) this.scheduleJob(state)
  }

  async remove(id: string): Promise<boolean> {
    const state = this.jobs.get(id)
    if (!state) return false
    if (state.timerId) clearTimeout(state.timerId)
    this.jobs.delete(id)
    await this.repo.deleteJob(id)
    return true
  }

  async enable(id: string): Promise<boolean> {
    const state = this.jobs.get(id)
    if (!state) return false
    state.config.enabled = true
    state.consecutiveFailures = 0
    await this.repo.setEnabled(id, true)
    if (this.running) this.scheduleJob(state)
    return true
  }

  async disable(id: string): Promise<boolean> {
    const state = this.jobs.get(id)
    if (!state) return false
    state.config.enabled = false
    if (state.timerId) {
      clearTimeout(state.timerId)
      state.timerId = null
    }
    await this.repo.setEnabled(id, false)
    return true
  }

  list(): JobSummary[] {
    return Array.from(this.jobs.values()).map((state) => {
      const status = state.running
        ? 'running'
        : !state.config.enabled
          ? 'disabled'
          : state.timerId
            ? 'scheduled'
            : 'idle'
      return { config: state.config, status, lastRun: state.lastRun }
    })
  }

  async runNow(id: string): Promise<string> {
    const state = this.jobs.get(id)
    if (!state) return `任务 ${id} 不存在`
    return this.executeJob(state)
  }

  async getRecentLogs(jobId?: string, limit?: number): Promise<RunLog[]> {
    return this.repo.getRecentLogs(jobId, limit)
  }

  /** 任务是否仍在管理器中且允许继续调度 */
  private isActive(state: CronJobState): boolean {
    return this.jobs.get(state.config.id) === state && state.config.enabled && this.running
  }

  private scheduleJob(state: CronJobState): void {
    if (state.timerId) {
      clearTimeout(state.timerId)
      state.timerId = null
    }
    try {
      const parsed = parseSchedule(state.config.schedule)
      let delayMs: number
      switch (parsed.type) {
        case 'interval':
          delayMs = parsed.intervalMs ?? 60_000
          break
        case 'once': {
          const onceAt = parsed.onceAt
          if (!onceAt) throw new Error('一次性任务缺少执行时间')
          const diff = onceAt.getTime() - Date.now()
          // 逾期的一次性任务（进程停机错过）立即补跑
          if (diff <= 0) {
            void this.executeJob(state).finally(() => this.remove(state.config.id))
            return
          }
          delayMs = diff
          break
        }
        case 'cron': {
          const cron = parsed.cronInstance
          if (!cron) throw new Error('cron 表达式解析失败')
          delayMs = getNextCronTime(cron)
          break
        }
      }

      state.config.scheduleType = parsed.type
      state.timerId = setTimeout(
        () => {
          state.timerId = null
          // 超过 setTimeout 上限的任务只是分段等待：到点后重新计算剩余时间
          if (delayMs > MAX_TIMER_DELAY) {
            if (this.isActive(state)) this.scheduleJob(state)
            return
          }
          void this.executeJob(state)
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err)
              console.log(`  [cron] ✗ ${state.config.id} 执行异常: ${message}`)
            })
            .finally(() => {
              // 执行期间任务可能已被删除：不能再为幽灵任务安排下一次
              if (!this.jobs.has(state.config.id)) return
              if (parsed.type === 'once') {
                void this.remove(state.config.id)
              } else if (state.config.enabled && this.running) {
                this.scheduleJob(state)
              }
            })
        },
        Math.min(delayMs, MAX_TIMER_DELAY),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  [cron] ✗ 调度失败 ${state.config.id}: ${message}`)
    }
  }

  private async executeJob(state: CronJobState): Promise<string> {
    if (state.running) return '任务正在执行中'
    state.running = true
    const startedAt = new Date().toISOString()
    let output = ''
    let status: RunLog['status'] = 'success'
    let error: string | undefined

    try {
      const timeout = state.config.timeout || 60_000
      output = await this.runPayload(state.config.payload, timeout)
      state.consecutiveFailures = 0
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      status = message.includes('timeout') ? 'timeout' : 'error'
      error = message
      output = `执行失败: ${message}`
      state.consecutiveFailures++
      const maxRetries = state.config.maxRetries ?? 3
      if (state.consecutiveFailures >= maxRetries) {
        state.config.enabled = false
        // 手动执行触发熔断时，已排好的下一次也必须取消
        if (state.timerId) {
          clearTimeout(state.timerId)
          state.timerId = null
        }
        console.log(`  [cron] ✗ ${state.config.id} 连续失败 ${maxRetries} 次，已自动禁用`)
        await this.repo.setEnabled(state.config.id, false)
      }
    } finally {
      state.running = false
    }

    const log: RunLog = {
      jobId: state.config.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      output: output.slice(0, 1000),
      error,
    }
    state.lastRun = log
    await this.repo.appendLog(log)
    if (this.executor?.notify) {
      const icon = status === 'success' ? '✓' : '✗'
      this.executor.notify(`[cron] ${icon} ${state.config.name}: ${output.slice(0, 200)}`)
    }
    return output
  }

  private async runPayload(payload: JobPayload, timeout: number): Promise<string> {
    if (!this.executor) return '[cron] 未设置执行器，无法运行任务'
    if (payload.type === 'agent') {
      return this.executor.runAgentPrompt(payload.prompt, timeout)
    }
    if (payload.handler === 'random-quote') {
      return QUOTES[Math.floor(Math.random() * QUOTES.length)] ?? QUOTES[0] ?? ''
    }
    return `[handler] ${payload.handler} — handler 类型需要通过插件注册`
  }
}
