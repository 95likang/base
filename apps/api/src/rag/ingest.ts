import { chunkDocument } from './chunker'
import { type Embedder, embed } from './embedder'
import { InvalidDocumentError, loadDocument } from './loader'
import type { VectorStore } from './store'

export interface IngestResult {
  source: string
  chunks: number
  total: number
}

/** 文档导入管线：抽文本 → 分块 → 向量化 → 按 source 覆盖入库 */
export async function ingestFile(
  store: VectorStore,
  embedder: Embedder,
  source: string,
  data: Uint8Array,
): Promise<IngestResult> {
  const text = await loadDocument(source, data)
  const chunks = chunkDocument(source, text)
  if (chunks.length === 0) throw new InvalidDocumentError('文档没有可索引的文本内容')

  // 向量化后按 source 覆盖入库
  const embeddings = await embed(
    embedder,
    chunks.map((c) => c.text),
  )
  const items = chunks.map((chunk, i) => {
    const embedding = embeddings[i]
    if (!embedding) throw new Error('向量化结果不完整')
    return { chunk, embedding }
  })

  await store.addBatch(items)
  return { source, chunks: chunks.length, total: store.size() }
}
