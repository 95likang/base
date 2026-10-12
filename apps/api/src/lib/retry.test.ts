import { APICallError, NoOutputGeneratedError } from 'ai'
import { describe, expect, it } from 'vitest'
import { calculateDelay, isRetryable, retryAfterMs, sleep } from './retry'

/** 构造结构化的 API 调用错误 */
function apiError(opts: {
  statusCode?: number
  isRetryable?: boolean
  responseHeaders?: Record<string, string>
  message?: string
}) {
  return new APICallError({
    message: opts.message ?? 'api error',
    url: 'https://api.example.com/v1/chat',
    requestBodyValues: {},
    statusCode: opts.statusCode,
    isRetryable: opts.isRetryable,
    responseHeaders: opts.responseHeaders,
  })
}

describe('isRetryable：结构化 APICallError', () => {
  it.each([408, 429, 500, 502, 503, 529])('状态码 %i 可重试', (status) => {
    expect(isRetryable(apiError({ statusCode: status }))).toBe(true)
  })

  it.each([400, 401, 403, 404, 422])('状态码 %i 不可重试', (status) => {
    expect(isRetryable(apiError({ statusCode: status }))).toBe(false)
  })

  it('无状态码时信任 isRetryable 标记', () => {
    expect(isRetryable(apiError({ isRetryable: true }))).toBe(true)
    expect(isRetryable(apiError({ isRetryable: false }))).toBe(false)
  })

  it('4xx 但 provider 标记可重试时，以标记为准', () => {
    expect(isRetryable(apiError({ statusCode: 402, isRetryable: true }))).toBe(true)
  })
})

describe('isRetryable：其他错误类型', () => {
  it('NoOutputGeneratedError 可重试', () => {
    expect(isRetryable(new NoOutputGeneratedError())).toBe(true)
  })

  it.each(['fetch failed', 'network error', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'request timeout'])(
    '网络类 message "%s" 可重试',
    (message) => {
      expect(isRetryable(new Error(message))).toBe(true)
    },
  )

  it('带语义前缀的状态码可判定：5xx 可重试，4xx 不可重试', () => {
    expect(isRetryable(new Error('provider returned status 503 Service Unavailable'))).toBe(true)
    expect(isRetryable(new Error('status: 429 Too Many Requests'))).toBe(true)
    expect(isRetryable(new Error('HTTP 400 Bad Request'))).toBe(false)
  })

  it('普通业务错误不可重试', () => {
    expect(isRetryable(new Error('invalid input'))).toBe(false)
    expect(isRetryable(new Error('boom'))).toBe(false)
    expect(isRetryable('not an error')).toBe(false)
    expect(isRetryable(undefined)).toBe(false)
  })

  it('裸三位数不会被误判为状态码（订单号/记录 ID/耗时）', () => {
    expect(isRetryable(new Error('record 502 not found'))).toBe(false)
    expect(isRetryable(new Error('parsed 1000 tokens'))).toBe(false)
    expect(isRetryable(new Error('took 502ms'))).toBe(false)
  })
})

describe('calculateDelay：指数退避 + 抖动', () => {
  it('attempt 1 基准 500ms，抖动 ±25%', () => {
    for (let i = 0; i < 20; i++) {
      const delay = calculateDelay(1)
      expect(delay).toBeGreaterThanOrEqual(375)
      expect(delay).toBeLessThanOrEqual(625)
    }
  })

  it('随 attempt 指数增长', () => {
    for (let i = 0; i < 20; i++) {
      const delay = calculateDelay(3)
      expect(delay).toBeGreaterThanOrEqual(1500) // 500 * 2^2 = 2000，±25%
      expect(delay).toBeLessThanOrEqual(2500)
    }
  })

  it('封顶 30s', () => {
    for (let i = 0; i < 20; i++) {
      const delay = calculateDelay(20)
      expect(delay).toBeLessThanOrEqual(37500) // 30000 ± 25%
      expect(delay).toBeGreaterThanOrEqual(22500)
    }
  })
})

describe('retryAfterMs：Retry-After 头解析', () => {
  it('秒数格式（小写头）', () => {
    expect(
      retryAfterMs(apiError({ statusCode: 429, responseHeaders: { 'retry-after': '2' } })),
    ).toBe(2000)
  })

  it('秒数格式（大写头）', () => {
    expect(
      retryAfterMs(apiError({ statusCode: 429, responseHeaders: { 'Retry-After': '5' } })),
    ).toBe(5000)
  })

  it('超过 30s 封顶的建议不采纳，退回 undefined（P1 回归锚点）', () => {
    expect(
      retryAfterMs(apiError({ statusCode: 429, responseHeaders: { 'retry-after': '60' } })),
    ).toBeUndefined()
    expect(
      retryAfterMs(apiError({ statusCode: 429, responseHeaders: { 'retry-after': '120' } })),
    ).toBeUndefined()
  })

  it('恰好等于封顶时采纳', () => {
    expect(
      retryAfterMs(apiError({ statusCode: 429, responseHeaders: { 'retry-after': '30' } })),
    ).toBe(30000)
  })

  it('无头或非 APICallError 返回 undefined', () => {
    expect(retryAfterMs(apiError({ statusCode: 429 }))).toBeUndefined()
    expect(retryAfterMs(new Error('fetch failed'))).toBeUndefined()
  })

  it('无法解析的值返回 undefined', () => {
    expect(
      retryAfterMs(apiError({ statusCode: 429, responseHeaders: { 'retry-after': 'soon' } })),
    ).toBeUndefined()
  })
})

describe('sleep', () => {
  it('正常等待后 resolve', async () => {
    await expect(sleep(10)).resolves.toBeUndefined()
  })

  it('等待期间 abort 立即 reject', async () => {
    const controller = new AbortController()
    const p = sleep(5000, controller.signal)
    setTimeout(() => controller.abort(), 10)
    await expect(p).rejects.toThrow()
  })

  it('已 abort 的信号直接 reject', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleep(1000, controller.signal)).rejects.toThrow()
  })
})
