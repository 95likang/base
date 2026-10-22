import { describe, expect, it } from 'vitest'
import {
  coreRules,
  deferredTools,
  memoryContext,
  PromptBuilder,
  type PromptContext,
  sessionContext,
  toolGuide,
} from './prompt-builder'

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    toolCount: 0,
    deferredToolSummary: '',
    sessionMessageCount: 0,
    sessionId: 'chat-1',
    memories: [],
    knowledgeBase: { size: 0, sources: [] },
    ...overrides,
  }
}

describe('PromptBuilder', () => {
  it('build 用空行拼接所有非 null 段', () => {
    const builder = new PromptBuilder()
      .pipe('a', () => '第一段')
      .pipe('b', () => null)
      .pipe('c', () => '第三段')
    expect(builder.build(makeCtx())).toBe('第一段\n\n第三段')
  })

  it('全部 pipe 返回 null 时产出空串', () => {
    const builder = new PromptBuilder().pipe('a', () => null)
    expect(builder.build(makeCtx())).toBe('')
  })
})

describe('预定义 pipe', () => {
  it('coreRules：恒定输出', () => {
    expect(coreRules()(makeCtx())).toContain('Super Agent')
  })

  it('toolGuide：无工具时为 null，有工具时带数量', () => {
    expect(toolGuide()(makeCtx({ toolCount: 0 }))).toBeNull()
    expect(toolGuide()(makeCtx({ toolCount: 5 }))).toContain('5 个工具')
  })

  it('deferredTools：无延迟目录时为 null，有则透传目录', () => {
    expect(deferredTools()(makeCtx())).toBeNull()
    const summary =
      '\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n  - mcp__github__x'
    const out = deferredTools()(makeCtx({ deferredToolSummary: summary }))
    expect(out).toBe(summary.trim())
  })

  it('sessionContext：无历史时为 null，有则带会话 id 与条数', () => {
    expect(sessionContext()(makeCtx())).toBeNull()
    const out = sessionContext()(makeCtx({ sessionMessageCount: 3 }))
    expect(out).toContain('chat-1')
    expect(out).toContain('3 条')
  })

  it('memoryContext：无记忆时给引导语，有则按类型分组且只含索引', () => {
    expect(memoryContext()(makeCtx())).toContain('没有存储任何记忆')
    const now = new Date()
    const out = memoryContext()(
      makeCtx({
        memories: [
          {
            id: 'm1',
            type: 'user',
            name: '用户偏好 TS',
            description: '用户偏好 TypeScript',
            content: '写示例代码时优先用 TypeScript',
            expiresAt: null,
            updatedAt: now,
          },
          {
            id: 'm2',
            type: 'project',
            name: '冻结合并',
            description: '非核心合并冻结',
            content: '移动端要切分支',
            expiresAt: new Date('2026-05-07T23:59:59Z'),
            updatedAt: now,
          },
        ],
      }),
    )
    expect(out).toContain('[m1] 用户偏好 TS — 用户偏好 TypeScript')
    expect(out).toContain('# 用户画像')
    expect(out).toContain('截止 2026-05-07')
    // 索引懒加载：content 不进 prompt
    expect(out).not.toContain('写示例代码时优先用 TypeScript')
  })
})
