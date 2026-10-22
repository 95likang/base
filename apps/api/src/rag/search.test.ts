import { describe, expect, it } from 'vitest'
import { type Embedder, embed } from './embedder'
import { hybridSearch } from './search'
import type { StoredChunk, VectorStore } from './store'

/**
 * 关键词驱动的测试向量：提到「部署」/「回滚」的文本在对应维度上为 1。
 * 可控向量用于稳定验证排序。
 */
const keywordEmbedder: Embedder = {
  name: 'test-keyword',
  embed: async (texts) =>
    texts.map((text) => [text.includes('部署') ? 1 : 0, text.includes('回滚') ? 1 : 0]),
}

/** 构造只读片段源，避免测试依赖 PG */
async function makeSource(
  texts: string[],
  embeddingFn: Embedder,
): Promise<Pick<VectorStore, 'getAll'>> {
  const embeddings = await embed(embeddingFn, texts)
  const chunks: StoredChunk[] = texts.map((text, i) => ({
    id: `doc#${i}`,
    text,
    source: 'doc.md',
    index: i,
    embedding: embeddings[i] ?? [],
  }))
  return { getAll: () => chunks }
}

describe('hybridSearch', () => {
  it('空库返回空数组', async () => {
    expect(await hybridSearch({ getAll: () => [] }, keywordEmbedder, '任何问题')).toEqual([])
  })

  it('关键词命中的片段排在第一位', async () => {
    const source = await makeSource(
      [
        '今天天气不错，适合出门散步。',
        '部署事故的应急流程：先回滚到上一个版本，再排查日志。',
        '苹果香蕉橘子都是水果。',
      ],
      keywordEmbedder,
    )

    const results = await hybridSearch(source, keywordEmbedder, '部署事故 回滚', 3)

    expect(results[0]?.chunk.id).toBe('doc#1')
    expect(results[0]?.keywordScore).toBeGreaterThan(0)
  })

  it('按 topK 截断且综合分在 [0,1] 内', async () => {
    const source = await makeSource(
      [
        '部署流程第一步：拉取最新代码。',
        '部署流程第二步：执行数据库迁移。',
        '部署完成后检查健康检查接口。',
        '完全无关的一段内容。',
      ],
      keywordEmbedder,
    )

    const results = await hybridSearch(source, keywordEmbedder, '部署流程', 2)

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBeLessThanOrEqual(1)
    }
  })
})
