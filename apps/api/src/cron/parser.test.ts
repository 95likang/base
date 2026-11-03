import { describe, expect, it } from 'vitest'
import { parseSchedule, resolveRelativeSchedule } from './parser'

const NOW = Date.parse('2026-11-03T02:00:00.000Z')

describe('resolveRelativeSchedule', () => {
  it('把相对时间换算成绝对时间', () => {
    expect(resolveRelativeSchedule('in 5m', NOW)).toBe('2026-11-03T02:05:00.000Z')
    expect(resolveRelativeSchedule('in 2h', NOW)).toBe('2026-11-03T04:00:00.000Z')
    expect(resolveRelativeSchedule('in 30s', NOW)).toBe('2026-11-03T02:00:30.000Z')
  })

  it('非相对时间原样返回', () => {
    expect(resolveRelativeSchedule('*/5 * * * *')).toBe('*/5 * * * *')
    expect(resolveRelativeSchedule('2026-11-03T02:05:00.000Z')).toBe('2026-11-03T02:05:00.000Z')
  })

  it('转换结果能被解析为一次性任务', () => {
    const iso = resolveRelativeSchedule('in 5m', NOW)
    expect(parseSchedule(iso)).toMatchObject({
      type: 'once',
      onceAt: new Date('2026-11-03T02:05:00.000Z'),
    })
  })

  it('非正的相对时间报错', () => {
    expect(() => resolveRelativeSchedule('in 0m')).toThrow()
  })
})
