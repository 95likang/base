/**
 * Cron 任务的数据结构。
 * 调度表达式支持三种形式：cron 五字段、固定间隔（every 30s）、一次性 ISO 时间戳。
 */

export type ScheduleType = 'cron' | 'interval' | 'once'

/** 任务来源：config 由配置文件管理（不可通过工具删除），runtime 由 Agent/管理页动态创建 */
export type JobSource = 'config' | 'runtime'

export interface CronJobConfig {
  /** 任务唯一标识 */
  id: string
  /** 任务显示名称 */
  name: string
  /** 可选的任务描述 */
  description?: string
  /** 调度表达式：cron 五字段 | "every 30s" | ISO 时间戳 */
  schedule: string
  /** 解析后的调度类型 */
  scheduleType: ScheduleType
  /** 是否启用 */
  enabled: boolean
  /** 执行内容（agent prompt 或 handler 回调） */
  payload: JobPayload
  /** 单次执行超时，单位 ms，默认 60000 */
  timeout?: number
  /** 连续失败多少次后自动禁用，默认 3 */
  maxRetries?: number
  source: JobSource
}

export type JobPayload =
  | { type: 'agent'; prompt: string }
  | { type: 'handler'; handler: string }
  /**
   * 直接推送提醒文本（不走 Agent）。
   * 默认附带「稍后提醒 / 关闭」按钮；一次性的语义化提醒（如计划开始）设 actions: 'none' 只发纯文本。
   */
  | { type: 'reminder'; text: string; actions?: 'none' }

/** 提醒文本长度上限：Discord 单条消息 2000 字符，留出 @ 与按钮结果余量 */
export const MAX_REMINDER_LENGTH = 1500

/** 三个入口（工具 / HTTP / 管理页）共用：handler > reminder > agent */
export function buildJobPayload(input: {
  prompt?: string
  text?: string
  handler?: string
}): JobPayload {
  if (input.handler) return { type: 'handler', handler: input.handler }
  if (input.text) return { type: 'reminder', text: input.text }
  return { type: 'agent', prompt: input.prompt ?? '' }
}

export interface RunLog {
  /** 所属任务 ID */
  jobId: string
  /** 开始时间 ISO 字符串 */
  startedAt: string
  /** 结束时间 ISO 字符串 */
  finishedAt: string
  status: 'success' | 'error' | 'timeout'
  /** 执行输出（截断到 1000 字符） */
  output?: string
  /** 错误信息 */
  error?: string
}

export interface CronJobState {
  config: CronJobConfig
  /** 当前定时器句柄 */
  timerId: ReturnType<typeof setTimeout> | null
  /** 上一次执行记录 */
  lastRun?: RunLog
  /** 连续失败计数 */
  consecutiveFailures: number
  /** 是否正在执行中 */
  running: boolean
}

/** 任务运行状态（list 返回值里的 status） */
export type JobStatus = 'running' | 'disabled' | 'scheduled' | 'idle'

export interface JobSummary {
  config: CronJobConfig
  status: JobStatus
  lastRun?: RunLog
}
