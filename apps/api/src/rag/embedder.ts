/**
 * 向量化：Embedder 携带模型名（持久化时标记向量来源，不同模型的向量不可比较）。
 * 使用 DashScope compatible-mode；DASHSCOPE_API_KEY 缺失时启动直接报错。
 */
type EmbeddingFn = (texts: string[]) => Promise<number[][]>

export interface Embedder {
  name: string
  embed: EmbeddingFn
}

/** DashScope embedding 模型（compatible-mode） */
const DASHSCOPE_MODEL = 'qwen3.7-text-embedding-flash'

/** DashScope compatible-mode 单次最多 10 条输入，按批发送并保持顺序 */
const DASHSCOPE_BATCH_SIZE = 10

function createDashScopeEmbedder(apiKey: string): Embedder {
  return {
    name: DASHSCOPE_MODEL,
    embed: async (texts) => {
      const vectors: number[][] = []
      for (let i = 0; i < texts.length; i += DASHSCOPE_BATCH_SIZE) {
        const batch = texts.slice(i, i + DASHSCOPE_BATCH_SIZE)
        const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: DASHSCOPE_MODEL,
            input: batch,
          }),
        })
        if (!resp.ok) {
          throw new Error(`Embedding API error: ${resp.status} ${await resp.text()}`)
        }
        const data = (await resp.json()) as { data: Array<{ embedding: number[] }> }
        vectors.push(...data.data.map((d) => d.embedding))
      }
      return vectors
    },
  }
}

export function createEmbedderFromEnv(): Embedder {
  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!apiKey) {
    throw new Error(
      'DASHSCOPE_API_KEY is not set. Copy apps/api/.env.example to .env and fill it in.',
    )
  }
  return createDashScopeEmbedder(apiKey)
}

/** 进程内向量缓存：key 含模型名，不同模型的向量空间不可比；超限直接清空（简单防泄漏） */
const cache = new Map<string, number[]>()
const CACHE_LIMIT = 5000

export async function embed(embedder: Embedder, texts: string[]): Promise<number[][]> {
  const results: number[][] = new Array(texts.length)
  const uncached: Array<{ idx: number; text: string }> = []

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? ''
    const cached = cache.get(`${embedder.name}\u0000${text}`)
    if (cached) {
      results[i] = cached
    } else {
      uncached.push({ idx: i, text })
    }
  }

  if (uncached.length === 0) return results

  const vectors = await embedder.embed(uncached.map((u) => u.text))
  if (vectors.length !== uncached.length) {
    throw new Error(`Embedding 返回数量不匹配: ${vectors.length} != ${uncached.length}`)
  }
  if (cache.size + uncached.length > CACHE_LIMIT) cache.clear()
  uncached.forEach(({ idx, text }, i) => {
    const vector = vectors[i]
    if (!vector) return
    results[idx] = vector
    cache.set(`${embedder.name}\u0000${text}`, vector)
  })

  return results
}

export function cosineSimilarity(a: number[], b: number[]): number {
  // 维度不一致（历史数据来自其他模型）时无法比较，返回 0 而不是 NaN
  if (a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
}
