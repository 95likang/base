import type { LanguageModelUsage } from 'ai'
import { describe, expect, it } from 'vitest'
import { computeCost, normalizeUsage, UsageTracker } from './tracker'

/** 构造 ai v7 形状的 usage（字段全给，缺省为 undefined） */
function mkUsage(usage: {
  inputTokens?: number
  noCacheTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
}): LanguageModelUsage {
  return {
    inputTokens: usage.inputTokens,
    inputTokenDetails: {
      noCacheTokens: usage.noCacheTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
  }
}

describe('computeCost', () => {
  it('四类 token 按价格表分别计价', () => {
    const cost = computeCost('claude-sonnet-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })
    // 3 + 15 + 0.3 + 3.75
    expect(cost).toBeCloseTo(22.05, 6)
  })

  it('未知模型回退默认价格（sonnet-4-5）', () => {
    const cost = computeCost('unknown-model', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(cost).toBeCloseTo(3.0, 6)
  })
})

describe('normalizeUsage', () => {
  it('有 noCache 明细时直接取（Anthropic 路径）', () => {
    const u = normalizeUsage(
      mkUsage({
        inputTokens: 1000,
        noCacheTokens: 200,
        cacheReadTokens: 600,
        cacheWriteTokens: 200,
        outputTokens: 50,
      }),
    )
    expect(u).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 600,
      cacheWriteTokens: 200,
    })
  })

  it('无 noCache 明细时从 inputTokens 总数里减出 cache 读（OpenAI 风格）', () => {
    const u = normalizeUsage(mkUsage({ inputTokens: 1000, cacheReadTokens: 600, outputTokens: 50 }))
    expect(u.inputTokens).toBe(400)
    expect(u.cacheReadTokens).toBe(600)
  })

  it('空 usage 全零', () => {
    const u = normalizeUsage(mkUsage({}))
    expect(u).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })
})

describe('UsageTracker', () => {
  it('totals 聚合 + 命中率 + cache 节省', () => {
    const tracker = new UsageTracker() // 不传 logPath → 不落盘
    tracker.record('claude-sonnet-4-5', {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 3000,
      cacheWriteTokens: 1000,
    })
    const totals = tracker.totals()
    expect(totals.steps).toBe(1)
    // 命中率 = 3000 / (1000 + 3000 + 1000)
    expect(totals.hitRate).toBeCloseTo(0.6, 6)
    // cache 写 1.25x 比全 miss 贵，但读 0.1x 便宜得多 → 净节省为正
    expect(totals.savedCost).toBeGreaterThan(0)
    expect(totals.cost).toBeLessThan(totals.baselineCost)
  })

  it('recent 返回最后 n 条', () => {
    const tracker = new UsageTracker()
    for (let i = 0; i < 5; i++) {
      tracker.record('claude-sonnet-4-5', {
        inputTokens: i,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    }
    expect(tracker.recent(2).map((r) => r.inputTokens)).toEqual([3, 4])
  })

  it('按会话过滤：totals / recent 只统计该会话的步骤', () => {
    const tracker = new UsageTracker()
    tracker.record(
      'claude-sonnet-4-5',
      { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 3000, cacheWriteTokens: 0 },
      'chat-a',
    )
    tracker.record(
      'claude-sonnet-4-5',
      { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'chat-b',
    )
    tracker.record(
      'claude-sonnet-4-5',
      { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'chat-a',
    )

    const a = tracker.totals('chat-a')
    expect(a.steps).toBe(2)
    expect(a.inputTokens).toBe(1100)
    expect(a.cacheReadTokens).toBe(3000)
    expect(a.hitRate).toBeCloseTo(3000 / 4100, 6)

    const all = tracker.totals()
    expect(all.steps).toBe(3)
    expect(all.inputTokens).toBe(1600)

    expect(tracker.recent(10, 'chat-a').every((r) => r.chatId === 'chat-a')).toBe(true)
  })
})
