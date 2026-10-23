import { Cron } from 'croner'
import type { ScheduleType } from './types'

export interface ParsedSchedule {
  type: ScheduleType
  /** interval 类型：固定间隔毫秒数 */
  intervalMs?: number
  /** cron 类型：croner 实例，负责计算下次执行时间 */
  cronInstance?: Cron
  /** once 类型：一次性执行的目标时间 */
  onceAt?: Date
}

/** every 30s / every 5m / every 1h */
const INTERVAL_RE = /^every\s+(\d+)\s*(s|sec|m|min|h|hour)s?$/i
/** 以日期开头的表达式按一次性任务处理 */
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/

/** 只判断表达式形态，不做完整校验（解析交给 parseSchedule） */
export function detectScheduleType(expr: string): ScheduleType {
  if (INTERVAL_RE.test(expr)) return 'interval'
  if (DATE_PREFIX_RE.test(expr)) return 'once'
  return 'cron'
}

/**
 * 解析调度表达式；无法识别的表达式抛错。
 * cron 表达式非法时由 croner 构造函数抛出。
 */
export function parseSchedule(expr: string): ParsedSchedule {
  const intervalMatch = expr.match(INTERVAL_RE)
  if (intervalMatch) {
    const value = Number.parseInt(intervalMatch[1] ?? '0', 10)
    // 0 秒间隔会在 setTimeout(0) 里空转打满 CPU，直接拒绝
    if (value <= 0) throw new Error(`间隔必须大于 0: ${expr}`)
    const unit = (intervalMatch[2] ?? 's').toLowerCase()
    const multiplier = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000
    return { type: 'interval', intervalMs: value * multiplier }
  }

  if (DATE_PREFIX_RE.test(expr)) {
    const date = new Date(expr)
    if (!Number.isNaN(date.getTime())) {
      return { type: 'once', onceAt: date }
    }
  }

  return { type: 'cron', cronInstance: new Cron(expr) }
}

/** 距下次 cron 触发还有多少毫秒；取不到时退回 1 分钟 */
export function getNextCronTime(cron: Cron): number {
  return cron.msToNext() ?? 60_000
}
