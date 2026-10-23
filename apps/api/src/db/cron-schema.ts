import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import type { JobPayload } from '../cron/types'

/**
 * 定时任务定义。source 区分运行时创建（runtime）与配置文件管理（config）。
 */
export const cronJob = pgTable('cron_job', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  schedule: text('schedule').notNull(),
  scheduleType: text('schedule_type').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  payload: jsonb('payload').$type<JobPayload>().notNull(),
  timeout: integer('timeout'),
  maxRetries: integer('max_retries'),
  source: text('source').notNull().default('runtime'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})

/**
 * 执行日志。不建外键：删除任务后保留历史记录用于排查。
 */
export const cronRunLog = pgTable(
  'cron_run_log',
  {
    id: serial('id').primaryKey(),
    jobId: text('job_id').notNull(),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at').notNull(),
    status: text('status').notNull(),
    output: text('output'),
    error: text('error'),
  },
  (table) => [index('cron_run_log_jobId_startedAt_idx').on(table.jobId, table.startedAt)],
)

export type CronJobRow = typeof cronJob.$inferSelect
export type CronRunLogRow = typeof cronRunLog.$inferSelect
