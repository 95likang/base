import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from './store'
import { extractPaths, lintAll, validateEntry } from './validator'

const now = Date.now()
const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000)

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1',
    type: 'project',
    name: '测试记忆',
    description: '描述',
    content: '内容',
    expiresAt: null,
    lastReadAt: new Date(now),
    updatedAt: new Date(now),
    ...overrides,
  }
}

describe('extractPaths', () => {
  it('提取内容里的文件路径，忽略 URL 与普通文本', () => {
    const paths = extractPaths('改 src/routes/chat.ts，参考 https://example.com/doc/readme.md')
    expect(paths).toEqual(['src/routes/chat.ts'])
  })
})

describe('validateEntry', () => {
  it('引用的路径不存在时报 stale_path', () => {
    const issues = validateEntry(makeEntry({ content: '看 src/definitely-missing.ts' }), ['.'])
    expect(issues.map((i) => i.kind)).toEqual(['stale_path'])
  })

  it('超过类型保质期未读时报 never_used', () => {
    const issues = validateEntry(makeEntry({ type: 'reference', lastReadAt: daysAgo(30) }), '.')
    expect(issues.map((i) => i.kind)).toEqual(['never_used'])
  })

  it('从没读过时按最后写入时间计时', () => {
    const issues = validateEntry(
      makeEntry({ type: 'feedback', lastReadAt: null, updatedAt: daysAgo(120) }),
      '.',
    )
    expect(issues.map((i) => i.kind)).toEqual(['never_used'])
  })

  it('已过 expiresAt 时报 expired', () => {
    const issues = validateEntry(makeEntry({ expiresAt: daysAgo(1) }), ['.'])
    expect(issues.map((i) => i.kind)).toEqual(['expired'])
  })

  it('新鲜记忆没有问题', () => {
    expect(validateEntry(makeEntry(), ['.'])).toEqual([])
  })
})

describe('lintAll', () => {
  it('同名且未过期的记忆报 duplicate_name', () => {
    const reports = lintAll([
      makeEntry({ id: 'a', name: '部署流程' }),
      makeEntry({ id: 'b', name: '部署流程' }),
    ])
    expect(reports.flatMap((r) => r.issues.map((i) => i.kind))).toEqual([
      'duplicate_name',
      'duplicate_name',
    ])
  })

  it('过期行允许同名，只报 expired 不报重复', () => {
    const reports = lintAll([
      makeEntry({ id: 'a', name: '部署流程' }),
      makeEntry({ id: 'b', name: '部署流程', expiresAt: daysAgo(1) }),
    ])
    expect(reports.flatMap((r) => r.issues.map((i) => i.kind))).toEqual(['expired'])
  })
})
