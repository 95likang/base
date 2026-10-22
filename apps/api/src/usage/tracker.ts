/**
 * 成本追踪：token 四分类计价 + 跨步骤累计。
 *
 * 各家模型的 prompt cache 计费规则（单位：$ / 1M tokens，2026-10 数据）。
 * 命中折扣不是行业默认 10x，每家差异不小：
 * - Claude：cache read = 5%~10% input（Sonnet 5.5 十月起降到 5%）；write 5min = 125%、1h = 200%
 * - OpenAI：自动缓存，GPT-5.4 / 5.5 系列命中 = 10% input，无写入费
 * - Gemini：3 代起只支持 implicit caching，命中 = 5%~10% input（explicit 按存储时长另收费）
 * - DeepSeek：V4 系列（2026-08 起）峰谷定价 + cache hit 约为 miss 的 2%~3%（峰时价计），无写入费
 * - Qwen：implicit 20%、explicit 10%（字段跟 Anthropic 一样是 `cache_control: ephemeral`）
 * - Kimi：自动模式 25%
 * - Doubao：显式 cache，命中价 = 40% miss
 * （Qwen / Kimi / Doubao 为 2026-05 数据，未重新验证）
 *
 * 加新模型直接扩这张表就行。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LanguageModelUsage } from 'ai'

export interface ModelPricing {
  input: number // $ / 1M input tokens (cache miss)
  output: number // $ / 1M output tokens
  cacheWrite: number // $ / 1M tokens written to cache
  cacheRead: number // $ / 1M tokens read from cache (hit)
}

export const PRICE_TABLE: Record<string, ModelPricing> = {
  // Anthropic（2026-10-07 调价后：Sonnet 5.5 cache read 降 50%；本项目默认走 claude-sonnet-4-5）
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  // Anthropic 旧代（仍在售）
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  // OpenAI（GPT-5.4 / 5.5 系列；无写入费 → cacheWrite = input 价）
  'gpt-5-5': { input: 5.0, output: 30.0, cacheWrite: 5.0, cacheRead: 0.5 },
  'gpt-5-4': { input: 2.5, output: 15.0, cacheWrite: 2.5, cacheRead: 0.25 },
  'gpt-5-4-mini': { input: 0.75, output: 4.5, cacheWrite: 0.75, cacheRead: 0.075 },
  // Google（3 代起 implicit caching only；3.8 Flash 为介绍价，2027-01 起翻倍）
  'gemini-4-argon': { input: 2.0, output: 10.0, cacheWrite: 2.0, cacheRead: 0.1 },
  'gemini-3-1-pro': { input: 2.0, output: 12.0, cacheWrite: 2.0, cacheRead: 0.2 },
  'gemini-3-8-flash': { input: 0.75, output: 3.75, cacheWrite: 0.75, cacheRead: 0.075 },
  // 国产
  // DeepSeek V4 系列（2026-08-17 起峰谷定价：闲时 = 峰时一半，这里记峰时价；
  // V4 无写入费 → cacheWrite = input 价，cache hit 约为 miss 的 2%~3%）
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheWrite: 1.32, cacheRead: 0.044 },
  'deepseek-flash': { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.006 },
  'deepseek-v3-2': { input: 0.28, output: 0.42, cacheWrite: 0.28, cacheRead: 0.028 },
  'qwen3-6-plus': { input: 0.4, output: 1.2, cacheWrite: 0.4, cacheRead: 0.04 },
  'kimi-k2-6': { input: 0.6, output: 2.5, cacheWrite: 0.6, cacheRead: 0.15 },
  'doubao-2-0-pro': { input: 0.3, output: 0.9, cacheWrite: 0.3, cacheRead: 0.12 },
}

export interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface StepRecord extends StepUsage {
  ts: number
  model: string
  cost: number
  /** 步骤归属会话（进程累计查询时可不带） */
  chatId?: string
}

export interface UsageTotals extends StepUsage {
  cost: number
  /** cache 命中率 = cacheRead / 全部 input-like token */
  hitRate: number
  /** 没有 cache 时的"假想成本"：把所有 input-like token 当成 miss 全付 */
  baselineCost: number
  savedCost: number
  steps: number
}

export class UsageTracker {
  private steps: StepRecord[] = []
  private logPath?: string

  constructor(logPath?: string) {
    this.logPath = logPath
    if (logPath) mkdirSync(dirname(logPath), { recursive: true })
  }

  record(model: string, usage: StepUsage, chatId?: string): void {
    const cost = computeCost(model, usage)
    const record: StepRecord = { ts: Date.now(), model, cost, chatId, ...usage }
    this.steps.push(record)

    if (this.logPath) {
      appendFileSync(this.logPath, `${JSON.stringify(record)}\n`)
    }
  }

  /** 传 chatId 时只统计该会话的步骤（jsonl 审计日志同样带 chatId，可离线分析） */
  totals(chatId?: string): UsageTotals {
    const steps = chatId ? this.steps.filter((s) => s.chatId === chatId) : this.steps
    const t = steps.reduce(
      (a, s) => ({
        inputTokens: a.inputTokens + s.inputTokens,
        outputTokens: a.outputTokens + s.outputTokens,
        cacheReadTokens: a.cacheReadTokens + s.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + s.cacheWriteTokens,
        cost: a.cost + s.cost,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    )
    const totalInputLike = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens
    const hitRate = totalInputLike > 0 ? t.cacheReadTokens / totalInputLike : 0
    // 没有 cache 时的"假想成本"：把所有 input-like token 当成 miss 全付
    const baselineCost = (() => {
      let c = 0
      for (const s of steps) {
        const p = pricingFor(s.model)
        const inputLike = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens
        c += (inputLike * p.input) / 1_000_000
        c += (s.outputTokens * p.output) / 1_000_000
      }
      return c
    })()
    return {
      ...t,
      hitRate,
      baselineCost,
      savedCost: baselineCost - t.cost,
      steps: steps.length,
    }
  }

  recent(n: number, chatId?: string): StepRecord[] {
    const steps = chatId ? this.steps.filter((s) => s.chatId === chatId) : this.steps
    return steps.slice(-n)
  }
}

export function computeCost(model: string, usage: StepUsage): number {
  const p = pricingFor(model)
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  )
}

/** 价格表查不到时的兜底（= 项目默认模型 sonnet-4-5） */
const FALLBACK_PRICING: ModelPricing = {
  input: 3.0,
  output: 15.0,
  cacheWrite: 3.75,
  cacheRead: 0.3,
}

/** 价格表查不到时按项目默认模型（sonnet-4-5）估算，并提醒补表 */
function pricingFor(model: string): ModelPricing {
  const p = PRICE_TABLE[model]
  if (p) return p
  console.warn(`[usage] 价格表没有 "${model}"，按 claude-sonnet-4-5 估算，请在 PRICE_TABLE 补上`)
  return FALLBACK_PRICING
}

/**
 * 把 AI SDK v7 返回的 usage 规范化成四类 token。
 *
 * v7 里 `inputTokens` 是含 cache 的总数（Anthropic 映射：noCache + cacheRead + cacheWrite），
 * 明细在 `inputTokenDetails`：
 * - 有 noCacheTokens 明细（Anthropic）→ 直接取，inputTokens 不再重复扣
 * - 没有明细的 provider（如 OpenAI 把 cached 计入总数）→ 从 inputTokens 里减出 cache 读
 */
export function normalizeUsage(usage: LanguageModelUsage): StepUsage {
  const d = usage.inputTokenDetails ?? {}
  const cacheReadTokens = d.cacheReadTokens ?? 0
  const cacheWriteTokens = d.cacheWriteTokens ?? 0

  let inputTokens = d.noCacheTokens ?? usage.inputTokens ?? 0
  if (d.noCacheTokens == null && cacheReadTokens > 0 && inputTokens >= cacheReadTokens) {
    inputTokens -= cacheReadTokens
  }

  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
  }
}
