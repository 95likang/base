import { createAnthropic } from '@ai-sdk/anthropic'

/**
 * Anthropic 协议 provider 实例。
 * 通过 ANTHROPIC_BASE_URL 可指向任何 Anthropic Messages 协议兼容端点
 * （网关/中转等），SDK 会自动在 baseURL 后拼 /messages，模型名由 ANTHROPIC_MODEL 指定。
 */
export const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
})
