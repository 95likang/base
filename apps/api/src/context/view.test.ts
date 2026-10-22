import { describe, expect, it } from 'vitest'
import { buildContextSnapshot } from './view'

const messages = [
  { role: 'user' as const, content: '帮我读一下 README' },
  { role: 'assistant' as const, content: [{ type: 'text' as const, text: '好的' }] },
]

describe('buildContextSnapshot', () => {
  it('分区块汇总，用量 = 各区块之和', () => {
    const snapshot = buildContextSnapshot({
      modelId: 'claude-sonnet-4-5',
      windowTokens: 200_000,
      systemPromptChars: 4000,
      toolDescriptionChars: 8000,
      memoryChars: 0,
      skillsChars: 0,
      messages,
    })
    const names = snapshot.sections.map((s) => s.name)
    expect(names).toContain('system prompt')
    expect(names).toContain('tools')
    expect(names).toContain('user messages')
    expect(names).toContain('tool results')
    // 未配置的区块不出现
    expect(names).not.toContain('memory')
    expect(names).not.toContain('skills')
    expect(snapshot.usedTokens).toBe(snapshot.sections.reduce((a, s) => a + s.tokens, 0))
    expect(snapshot.freeTokens).toBe(200_000 - snapshot.usedTokens)
  })

  it('配置 memory / skills 后对应区块出现', () => {
    const snapshot = buildContextSnapshot({
      modelId: 'claude-sonnet-4-5',
      windowTokens: 200_000,
      systemPromptChars: 0,
      toolDescriptionChars: 0,
      memoryChars: 400,
      skillsChars: 800,
      messages: [],
    })
    const names = snapshot.sections.map((s) => s.name)
    expect(names).toContain('memory')
    expect(names).toContain('skills')
    expect(snapshot.usedTokens).toBe(100 + 200)
  })
})
