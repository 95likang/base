import { APICallError, NoOutputGeneratedError } from 'ai'

/** 值得重试的 HTTP 状态码：限流、请求超时、服务过载 */
const RETRYABLE_STATUS = new Set([408, 429, 529])

/**
 * 错误是否值得重试。
 *
 * 核心是分类：429 限流等一会就好，400 参数错误重试一万次也没用。
 * 优先走结构化判断（AI SDK 的 APICallError 自带 statusCode / isRetryable /
 * responseHeaders），message 正则只作为非结构化错误（裸网络错误等）的兜底。
 */
export function isRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    const { statusCode } = error
    if (statusCode === undefined) return error.isRetryable
    if (RETRYABLE_STATUS.has(statusCode)) return true
    if (statusCode >= 500 && statusCode < 600) return true
    // 其他状态码（4xx 等）：信任 provider 的标记，默认不重试
    return error.isRetryable
  }

  // AI SDK 会把"模型没产出任何内容"包装成此错误，重试通常可恢复
  if (NoOutputGeneratedError.isInstance(error)) return true

  if (!(error instanceof Error)) return false

  const message = error.message || ''

  // 状态码兜底（某些 provider 只把状态码拼进 message）。
  // 只认带语义前缀的写法（status 503 / code 429 / HTTP 400），
  // 裸三位数（订单号、记录 ID、"502ms"）不当作状态码——
  // 兜底路径宁可漏掉可重试错误，不可误重试白烧配额。
  const statusMatch = message.match(/\b(?:status|code|http)\s*[:=]?\s*([1-5]\d{2})\b/i)
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1] ?? '', 10)
    if (RETRYABLE_STATUS.has(status)) return true
    if (status >= 500 && status < 600) return true
    if (status >= 400 && status < 500) return false
  }

  // 网络层错误
  if (/\b(ECONNRESET|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED)\b/.test(message)) {
    return true
  }
  if (message.includes('fetch failed') || message.includes('network')) return true
  if (/timeout/i.test(message)) return true

  return false
}

/**
 * 指数退避 + 随机抖动（±25%）。抖动避免并发重试在同一时刻扎堆。
 * attempt 从 1 开始：500ms → 1s → 2s → 4s ... 封顶 30s。
 */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * 2 ** (attempt - 1)
  const capped = Math.min(exponential, maxMs)
  const jitterRange = capped * 0.25
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange
  return Math.max(0, Math.round(jittered))
}

/**
 * 从错误的 Retry-After 头提取服务端建议的等待时间。
 * 支持秒数和 HTTP 日期两种格式；取不到返回 undefined。
 * 施加 maxMs 封顶：服务端建议可能远超客户端能接受的等待时间
 * （如 Retry-After: 120 会把请求挂起 2 分钟），超限值不采纳。
 */
export function retryAfterMs(error: unknown, maxMs = 30000): number | undefined {
  if (!APICallError.isInstance(error)) return undefined
  const v = error.responseHeaders?.['retry-after'] ?? error.responseHeaders?.['Retry-After']
  if (!v) return undefined
  const seconds = Number(v)
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : (() => {
        const date = new Date(v).getTime()
        return Number.isNaN(date) ? undefined : date - Date.now()
      })()
  if (ms === undefined) return undefined
  // 超过封顶返回 undefined：退回调用方的指数退避（其自身有封顶）
  return ms <= maxMs ? Math.max(0, ms) : undefined
}

/** 可中断的 sleep：等待期间客户端断开时立即 reject，不再继续重试 */
export function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortSignal?.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    abortSignal?.addEventListener('abort', onAbort, { once: true })
  })
}
