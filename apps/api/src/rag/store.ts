import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { ragChunks } from '../db/rag-schema'
import type { Chunk } from './chunker'

export interface StoredChunk extends Chunk {
  embedding: number[]
}

/** 管理页文档列表项（按 source 聚合） */
export interface RagDocument {
  source: string
  chunks: number
  model: string
  updatedAt: string
}

/**
 * 知识库存储：PG 持久化 + 进程内向量索引。
 *
 * 写路径先落库再同步内存（以 DB 为准）；读路径只查内存数组——
 * 检索算法（余弦 / BM25 / MMR）全部在 JS 里完成，不需要 pgvector。
 * 内存索引只加载当前 embedding 模型的行：不同模型的向量空间不可比。
 */
export class VectorStore {
  private chunks: StoredChunk[] = []
  private loaded: Promise<void> | null = null

  constructor(private readonly model: string) {}

  /** 首次使用时懒加载（并发调用共享同一个 Promise；失败则清空缓存，下次重试） */
  ensureLoaded(): Promise<void> {
    this.loaded ??= this.load().catch((err) => {
      this.loaded = null
      throw err
    })
    return this.loaded
  }

  private async load(): Promise<void> {
    const rows = await db.select().from(ragChunks).where(eq(ragChunks.model, this.model))
    this.chunks = rows.map((row) => ({
      id: row.id,
      text: row.text,
      source: row.source,
      index: row.chunkIndex,
      embedding: row.embedding,
    }))
  }

  /** 按 source 整体覆盖：DB 事务内先删后插，再同步内存 */
  async addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): Promise<void> {
    if (items.length === 0) return
    await this.ensureLoaded()

    const sources = [...new Set(items.map((item) => item.chunk.source))]
    await db.transaction(async (tx) => {
      await tx.delete(ragChunks).where(inArray(ragChunks.source, sources))
      await tx.insert(ragChunks).values(
        items.map(({ chunk, embedding }) => ({
          id: chunk.id,
          text: chunk.text,
          source: chunk.source,
          chunkIndex: chunk.index,
          embedding,
          model: this.model,
        })),
      )
    })

    const replaced = new Set(sources)
    this.chunks = this.chunks.filter((chunk) => !replaced.has(chunk.source))
    for (const { chunk, embedding } of items) {
      this.chunks.push({ ...chunk, embedding })
    }
  }

  getAll(): StoredChunk[] {
    return this.chunks
  }

  size(): number {
    return this.chunks.length
  }

  sources(): string[] {
    return [...new Set(this.chunks.map((chunk) => chunk.source))]
  }

  /** 删除某文档的全部片段（跨模型：管理语义是"删掉这份文档"） */
  async deleteSource(source: string): Promise<void> {
    // 先确保加载完成，否则并发的首次加载会在删除后把片段重新写回内存
    await this.ensureLoaded()
    await db.delete(ragChunks).where(eq(ragChunks.source, source))
    this.chunks = this.chunks.filter((chunk) => chunk.source !== source)
  }

  /** 清空知识库（DB + 内存） */
  async clear(): Promise<void> {
    await this.ensureLoaded()
    await db.delete(ragChunks)
    this.chunks = []
  }
}

/** 管理页文档列表：直接读 DB，含其他模型的历史数据 */
export async function listDocuments(): Promise<RagDocument[]> {
  const rows = await db
    .select({
      source: ragChunks.source,
      chunks: sql<number>`count(*)::int`,
      model: sql<string>`max(${ragChunks.model})`,
      updatedAt: sql<Date>`max(${ragChunks.updatedAt})`,
    })
    .from(ragChunks)
    .groupBy(ragChunks.source)
    .orderBy(sql`max(${ragChunks.updatedAt}) desc`)

  return rows.map((row) => ({
    source: row.source,
    chunks: row.chunks,
    model: row.model,
    updatedAt: new Date(row.updatedAt).toISOString(),
  }))
}
