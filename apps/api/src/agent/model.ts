import { createAnthropic } from '@ai-sdk/anthropic'
import { config } from '../config/loader'

/**
 * Anthropic 协议 provider 实例。
 * baseURL 可指向任何 Anthropic Messages 协议兼容端点（网关/中转等），
 * SDK 会自动在 baseURL 后拼 /messages。
 */
const anthropic = createAnthropic({
  apiKey: config.model.apiKey || undefined,
  baseURL: config.model.baseURL || undefined,
})

/** 默认对话模型：模型名 / 地址 / Key 全部来自配置（无配置文件时回落到 ANTHROPIC_*） */
export const defaultModel = anthropic(config.model.name)

/**
 * 显式输出上限：未知模型在 @ai-sdk/anthropic 里默认被压到 4096，
 * 思考过程会计入该额度，过长时正文还没开始就被截断。
 */
export const maxOutputTokens = config.model.maxOutputTokens
