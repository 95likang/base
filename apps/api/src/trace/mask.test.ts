import { describe, expect, it } from 'vitest'
import { maskTraceData, redactSensitive } from './mask'

describe('redactSensitive', () => {
  it('按字段名脱敏嵌套结构，token 复数不误伤', () => {
    const masked = redactSensitive({
      apiKey: 'sk-1',
      nested: { authorization: 'Bearer x', secret: 's' },
      list: [{ password: 'p' }],
      totalTokens: 12,
    })

    expect(masked).toEqual({
      apiKey: '[REDACTED]',
      nested: { authorization: '[REDACTED]', secret: '[REDACTED]' },
      list: [{ password: '[REDACTED]' }],
      totalTokens: 12,
    })
  })
})

describe('maskTraceData', () => {
  it('解析 JSON 后脱敏再序列化', () => {
    const input = JSON.stringify({ input: 'hi', apiKey: 'sk-1' })
    expect(JSON.parse(maskTraceData({ data: input }))).toEqual({
      input: 'hi',
      apiKey: '[REDACTED]',
    })
  })

  it('截断超过 8KB 的字符串并标记', () => {
    const long = 'a'.repeat(9000)
    const masked = JSON.parse(maskTraceData({ data: JSON.stringify({ output: long }) })) as {
      output: string
    }

    expect(masked.output.endsWith('…[truncated]')).toBe(true)
    expect(masked.output.length).toBeLessThan(long.length)
  })

  it('非 JSON 输入按原字符串截断', () => {
    const masked = maskTraceData({ data: 'b'.repeat(9000) })
    expect(masked.endsWith('…[truncated]')).toBe(true)
  })
})
