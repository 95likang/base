import { describe, expect, it } from 'vitest'
import { chunkDocument } from './chunker'

describe('chunkDocument', () => {
  it('短文档产出单个片段，id 为 source#index', () => {
    const text = '# 标题\n\n正文内容'
    const chunks = chunkDocument('a.md', text)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.id).toBe('a.md#0')
    expect(chunks[0]?.source).toBe('a.md')
    expect(chunks[0]?.index).toBe(0)
  })

  it('已有足够内容时遇到标题切分', () => {
    const text = `${'甲'.repeat(60)}\n\n## 第二节\n\n${'乙'.repeat(20)}`
    const chunks = chunkDocument('b.md', text)

    expect(chunks).toHaveLength(2)
    expect(chunks[1]?.text.startsWith('## 第二节')).toBe(true)
  })

  it('超长段落按句子切分，且每块不超过目标大小', () => {
    const sentence = `${'这是用来填充长度的一句话'.repeat(10)}。`
    const text = Array.from({ length: 20 }, () => sentence).join('')
    const chunks = chunkDocument('c.md', text)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.id)).toEqual(chunks.map((_, i) => `c.md#${i}`))
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1024)
    }
  })
})
