import { resolve } from 'node:path'
import { UsageTracker } from './tracker'

/**
 * 进程级累计用量（跨请求共享）：Web 对话与 Channel 对话的成本都记在这里，
 * 同时落一份 jsonl 审计日志（append-only，路径锚定在 apps/api/.usage/）。
 */
export const usageLog = new UsageTracker(resolve(import.meta.dirname, '../../.usage/usage.jsonl'))
