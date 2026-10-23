import { desc, eq, lt } from 'drizzle-orm'
import { db } from '../db'
import { type CronJobRow, type CronRunLogRow, cronJob, cronRunLog } from '../db/cron-schema'
import type { CronJobConfig, JobSource, RunLog, ScheduleType } from './types'

/** Cron 持久化：任务定义与执行日志都落在 PostgreSQL，重启后由 load() 恢复 */
export class CronRepository {
  async loadJobs(): Promise<CronJobConfig[]> {
    const rows = await db.select().from(cronJob)
    return rows.map(toConfig)
  }

  async saveJob(config: CronJobConfig): Promise<void> {
    const patch = {
      name: config.name,
      description: config.description ?? null,
      schedule: config.schedule,
      scheduleType: config.scheduleType,
      enabled: config.enabled,
      payload: config.payload,
      timeout: config.timeout ?? null,
      maxRetries: config.maxRetries ?? null,
      source: config.source,
    }
    await db
      .insert(cronJob)
      .values({ id: config.id, ...patch })
      .onConflictDoUpdate({ target: cronJob.id, set: patch })
  }

  async deleteJob(id: string): Promise<void> {
    await db.delete(cronJob).where(eq(cronJob.id, id))
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await db.update(cronJob).set({ enabled }).where(eq(cronJob.id, id))
  }

  async appendLog(log: RunLog): Promise<void> {
    await db.insert(cronRunLog).values({
      jobId: log.jobId,
      startedAt: new Date(log.startedAt),
      finishedAt: new Date(log.finishedAt),
      status: log.status,
      output: log.output ?? null,
      error: log.error ?? null,
    })
  }

  /** 最近 limit 条日志，按时间正序返回 */
  async getRecentLogs(jobId: string | undefined, limit = 10): Promise<RunLog[]> {
    const rows = await db
      .select()
      .from(cronRunLog)
      .where(jobId ? eq(cronRunLog.jobId, jobId) : undefined)
      .orderBy(desc(cronRunLog.id))
      .limit(limit)
    return rows.reverse().map(toRunLog)
  }

  /** 删除早于指定时间的日志（保留策略由调用方决定） */
  async pruneLogs(before: Date): Promise<void> {
    await db.delete(cronRunLog).where(lt(cronRunLog.startedAt, before))
  }
}

function toConfig(row: CronJobRow): CronJobConfig {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    schedule: row.schedule,
    scheduleType: row.scheduleType as ScheduleType,
    enabled: row.enabled,
    payload: row.payload,
    timeout: row.timeout ?? undefined,
    maxRetries: row.maxRetries ?? undefined,
    source: row.source as JobSource,
  }
}

function toRunLog(row: CronRunLogRow): RunLog {
  return {
    jobId: row.jobId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    status: row.status as RunLog['status'],
    output: row.output ?? undefined,
    error: row.error ?? undefined,
  }
}
