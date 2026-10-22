import { cosineSimilarity, type Embedder, embed } from './embedder'
import type { StoredChunk, VectorStore } from './store'

export interface SearchResult {
  chunk: StoredChunk
  score: number
  vectorScore: number
  keywordScore: number
}

const VECTOR_WEIGHT = 0.7
const KEYWORD_WEIGHT = 0.3
const CANDIDATE_MULTIPLIER = 4
const MMR_LAMBDA = 0.7

/**
 * 混合检索：向量相似度（0.7）+ BM25 关键词（0.3），
 * 各自归一化后按 id 合并，最后用 MMR 去掉重复内容。
 */
export async function hybridSearch(
  store: Pick<VectorStore, 'getAll'>,
  embedder: Embedder,
  query: string,
  topK = 5,
): Promise<SearchResult[]> {
  const all = store.getAll()
  if (all.length === 0) return []

  const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, all.length)

  // 路径 1：向量检索
  const [queryVec] = await embed(embedder, [query])
  if (!queryVec) return []
  const vectorResults = all
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount)

  // 路径 2：BM25 关键词检索（语料统计只算一次）
  const queryTerms = tokenize(query)
  const keywordResults =
    queryTerms.length === 0
      ? []
      : scoreKeywords(all, queryTerms)
          .filter((result) => result.score > 0)
          .slice(0, candidateCount)

  const vecNorm = normalizeMinMax(vectorResults.map((r) => r.score))
  const kwNorm = normalizeViaSigmoid(keywordResults.map((r) => r.score))

  // 按 chunk id 合并两路候选
  const candidates = new Map<string, SearchResult>()

  vectorResults.forEach((result, i) => {
    candidates.set(result.chunk.id, {
      chunk: result.chunk,
      score: (vecNorm[i] ?? 0) * VECTOR_WEIGHT,
      vectorScore: vecNorm[i] ?? 0,
      keywordScore: 0,
    })
  })

  keywordResults.forEach((result, i) => {
    const keywordScore = kwNorm[i] ?? 0
    const existing = candidates.get(result.chunk.id)
    if (existing) {
      existing.keywordScore = keywordScore
      existing.score += keywordScore * KEYWORD_WEIGHT
    } else {
      candidates.set(result.chunk.id, {
        chunk: result.chunk,
        score: keywordScore * KEYWORD_WEIGHT,
        vectorScore: 0,
        keywordScore,
      })
    }
  })

  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score)
  return mmrSelect(sorted, topK)
}

// ── BM25 ────────────────────────────────────────

interface IndexedDoc {
  chunk: StoredChunk
  termFreq: Map<string, number>
  length: number
}

interface TokenizedChunk {
  termFreq: Map<string, number>
  length: number
  set: Set<string>
}

/**
 * 分词结果按片段对象缓存：检索是热路径，避免每次查询都对全量语料重新分词。
 * 覆盖导入会替换成新的片段对象，WeakMap 自然回收旧条目。
 */
const tokenCache = new WeakMap<StoredChunk, TokenizedChunk>()

function tokenizeChunk(chunk: StoredChunk): TokenizedChunk {
  const cached = tokenCache.get(chunk)
  if (cached) return cached

  const tokens = tokenize(chunk.text)
  const termFreq = new Map<string, number>()
  for (const token of tokens) {
    termFreq.set(token, (termFreq.get(token) ?? 0) + 1)
  }
  const tokenized = { termFreq, length: tokens.length, set: new Set(tokens) }
  tokenCache.set(chunk, tokenized)
  return tokenized
}

/**
 * 中英文分词：英文/数字按词，中文按二元组（bigram）。
 * 不引入分词依赖的前提下，bigram 能让中文 BM25 真正命中
 * （整段中文当成一个 token 时，查询几乎不可能与原文完全相等）。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  const parts = text.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) ?? []

  for (const part of parts) {
    if (/^[a-z0-9_]/.test(part)) {
      if (part.length > 1) tokens.push(part)
      continue
    }
    if (part.length === 1) {
      tokens.push(part)
      continue
    }
    for (let i = 0; i < part.length - 1; i++) {
      tokens.push(part.slice(i, i + 2))
    }
  }

  return tokens
}

function scoreKeywords(
  chunks: StoredChunk[],
  queryTerms: string[],
): Array<{ chunk: StoredChunk; score: number }> {
  const k1 = 1.2
  const b = 0.75

  // 一次性建立词频 / 文档频率 / 平均长度
  const docs: IndexedDoc[] = chunks.map((chunk) => {
    const { termFreq, length } = tokenizeChunk(chunk)
    return { chunk, termFreq, length }
  })

  const docFreq = new Map<string, number>()
  for (const doc of docs) {
    for (const term of doc.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    }
  }

  const docCount = docs.length
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / (docCount || 1)

  return docs
    .map((doc) => {
      let score = 0
      for (const term of queryTerms) {
        const tf = doc.termFreq.get(term) ?? 0
        if (tf === 0) continue
        const df = docFreq.get(term) ?? 0
        const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1)
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgLength)))
        score += idf * tfNorm
      }
      return { chunk: doc.chunk, score }
    })
    .sort((a, b) => b.score - a.score)
}

// ── 归一化 ──────────────────────────────────────

function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return []
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min || 1
  return scores.map((score) => (score - min) / range)
}

function normalizeViaSigmoid(scores: number[]): number[] {
  return scores.map((score) => 1 / (1 + Math.exp(-score)))
}

// ── MMR 去重 ────────────────────────────────────

function mmrSelect(results: SearchResult[], topK: number): SearchResult[] {
  if (results.length <= topK) return results

  const first = results[0]
  if (!first) return []

  const selected: SearchResult[] = [first]
  const remaining = results.slice(1)

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0
    let bestMmr = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      if (!candidate) continue
      const maxSim = Math.max(
        ...selected.map((item) => jaccardSimilarity(item.chunk, candidate.chunk)),
      )
      const mmr = MMR_LAMBDA * candidate.score - (1 - MMR_LAMBDA) * maxSim
      if (mmr > bestMmr) {
        bestMmr = mmr
        bestIdx = i
      }
    }

    const best = remaining[bestIdx]
    if (!best) break
    selected.push(best)
    remaining.splice(bestIdx, 1)
  }

  return selected
}

function jaccardSimilarity(a: StoredChunk, b: StoredChunk): number {
  const setA = tokenizeChunk(a).set
  const setB = tokenizeChunk(b).set
  if (setA.size === 0 && setB.size === 0) return 0

  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection++
  }
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}
