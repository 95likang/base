import { resolve } from 'node:path'
import { config } from '../config/loader'
import { UsageTracker } from './tracker'

/**
 * 进程级累计用量（跨请求共享）：Web 对话与 Channel 对话的成本都记在这里，
 * 同时落一份 jsonl 审计日志（append-only，相对路径以 apps/api 为基准）。
 */
export const usageLog = new UsageTracker(
  resolve(import.meta.dirname, '../..', config.usage.trackingFile),
)
