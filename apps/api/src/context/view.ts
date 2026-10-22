/**
 * 上下文占用快照：把一次请求的上下文拆成 system prompt / 工具 schema /
 * 消息（按角色）等区块并粗估 token（参考 Claude Code 的 /context）。
 * 纯数据层，供 /api/usage/context 端点序列化给 web 面板渲染。
 */
import type { ModelMessage } from 'ai'
import { estimateMessageTokens } from './defense'

export interface ContextSnapshotInput {
  modelId: string
  /** 模型上下文窗口（tokens） */
  windowTokens: number
  systemPromptChars: number
  toolDescriptionChars: number
  /** 预留区块：未接入时传 0（参考 Claude Code /context 的结构） */
  memoryChars: number
  skillsChars: number
  messages: ModelMessage[]
}

export interface ContextSection {
  name: string
  tokens: number
}

export interface ContextSnapshot {
  modelId: string
  windowTokens: number
  sections: ContextSection[]
  usedTokens: number
  freeTokens: number
  usedPercent: number
}

const charsToTokens = (chars: number) => Math.ceil(chars / 4)

export function buildContextSnapshot(input: ContextSnapshotInput): ContextSnapshot {
  // 消息按角色分桶（system 单列：正常不会出现，出现说明有消息级 system 注入）
  const byRole = new Map<string, ModelMessage[]>()
  for (const msg of input.messages) {
    const bucket = byRole.get(msg.role) ?? []
    bucket.push(msg)
    byRole.set(msg.role, bucket)
  }
  const roleTokens = (role: string) => estimateMessageTokens(byRole.get(role) ?? [])

  const sections: ContextSection[] = [
    { name: 'system prompt', tokens: charsToTokens(input.systemPromptChars) },
    { name: 'tools', tokens: charsToTokens(input.toolDescriptionChars) },
    ...(input.memoryChars > 0
      ? [{ name: 'memory', tokens: charsToTokens(input.memoryChars) }]
      : []),
    ...(input.skillsChars > 0
      ? [{ name: 'skills', tokens: charsToTokens(input.skillsChars) }]
      : []),
    ...(byRole.has('system') ? [{ name: 'system messages', tokens: roleTokens('system') }] : []),
    { name: 'user messages', tokens: roleTokens('user') },
    { name: 'assistant messages', tokens: roleTokens('assistant') },
    { name: 'tool results', tokens: roleTokens('tool') },
  ]

  const usedTokens = sections.reduce((a, s) => a + s.tokens, 0)
  const freeTokens = Math.max(0, input.windowTokens - usedTokens)
  return {
    modelId: input.modelId,
    windowTokens: input.windowTokens,
    sections,
    usedTokens,
    freeTokens,
    usedPercent: Math.round((usedTokens / input.windowTokens) * 100),
  }
}
