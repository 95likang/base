import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * RAG 知识库片段。embedding 以 JSON 数组存 jsonb：
 * 检索时整体加载进内存做余弦/BM25，不依赖 pgvector 扩展。
 * 一次导入以 source 为单位整体覆盖（先删后插）。
 */
export const ragChunks = pgTable(
  'rag_chunks',
  {
    id: text('id').primaryKey(),
    text: text('text').notNull(),
    source: text('source').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    embedding: jsonb('embedding').$type<number[]>().notNull(),
    /** 生成向量的模型名，用于区分不同向量空间 */
    model: text('model').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('rag_chunks_source_idx').on(table.source)],
)
