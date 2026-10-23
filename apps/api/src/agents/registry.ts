import { DEFAULT_CONFIG, type SubAgentConfig, type SubAgentRun } from './types'

/** 运行记录保留上限：注册表是进程级单例，避免长跑进程内存无限增长 */
const MAX_RUNS = 200

/**
 * 子 Agent 注册表：记录谁在跑、结果是什么，并在 spawn 前做深度检查与并发槽位排队。
 * 进程级单例（/api/agents 与管理页读取同一份数据），并发上限对所有请求生效。
 */
export class SubAgentRegistry {
  private runs = new Map<string, SubAgentRun>()
  private config: SubAgentConfig
  private idCounter = 0
  /** 已占用的执行槽位（含刚拿到槽位、尚未 register 的极短窗口） */
  private slotInUse = 0
  /** 排队等待槽位的 FIFO 队列 */
  private waiters: Array<() => void> = []

  constructor(config?: Partial<SubAgentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  generateId(): string {
    return `sub-${++this.idCounter}-${Date.now().toString(36).slice(-4)}`
  }

  checkDepth(currentDepth: number): { ok: boolean; reason?: string } {
    if (currentDepth >= this.config.maxSpawnDepth) {
      return { ok: false, reason: `已达最大嵌套深度 ${this.config.maxSpawnDepth}` }
    }
    return { ok: true }
  }

  /**
   * 申请执行槽位：已满时排队等待，而不是直接拒绝。
   * 取消信号（超时/父请求中断）会移出队列并返回 false。
   * 槽位由 complete/fail 释放，直接转交给下一个等待者。
   */
  async acquireSlot(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false

    if (this.slotInUse < this.config.maxConcurrent) {
      this.slotInUse++
      return true
    }

    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve(ok)
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        settle(false)
      }
      const waiter = () => settle(true)

      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private releaseSlot(): void {
    const next = this.waiters.shift()
    if (next) {
      // 槽位直接转交，slotInUse 保持不变
      next()
    } else {
      this.slotInUse = Math.max(0, this.slotInUse - 1)
    }
  }

  register(run: SubAgentRun): void {
    this.runs.set(run.id, run)
    this.prune()
  }

  complete(id: string, result: string): void {
    const run = this.runs.get(id)
    if (run?.status !== 'running') return
    run.status = 'completed'
    run.result = result
    run.finishedAt = new Date().toISOString()
    this.releaseSlot()
  }

  fail(id: string, error: string, status: 'error' | 'timeout' = 'error'): void {
    const run = this.runs.get(id)
    if (run?.status !== 'running') return
    run.status = status
    run.error = error
    run.finishedAt = new Date().toISOString()
    this.releaseSlot()
  }

  getActiveRuns(): SubAgentRun[] {
    return Array.from(this.runs.values()).filter((run) => run.status === 'running')
  }

  /** 按启动时间正序返回全部运行记录 */
  getAllRuns(): SubAgentRun[] {
    return Array.from(this.runs.values())
  }

  getConfig(): SubAgentConfig {
    return this.config
  }

  /** 超出上限时按插入顺序淘汰最旧的已结束记录（运行中的不淘汰） */
  private prune(): void {
    if (this.runs.size <= MAX_RUNS) return
    for (const [id, run] of this.runs) {
      if (this.runs.size <= MAX_RUNS) break
      if (run.status !== 'running') this.runs.delete(id)
    }
  }
}
