/**
 * 文档分块：把长文档切成目标 256 token（约 1024 字符）的语义单元。
 * 切分优先级：段落 → 标题边界 → 句子。id 由 source + 序号构成，
 * 同一文档重复导入时按 source 整体覆盖。
 */
export interface Chunk {
  id: string
  text: string
  source: string
  index: number
}

const TARGET_TOKENS = 256
const CHARS_PER_TOKEN = 4
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN

export function chunkDocument(source: string, rawText: string): Chunk[] {
  const text = rawText.replace(/\r\n/g, '\n')
  const paragraphs = text.split(/\n{2,}/)
  const chunks: Chunk[] = []
  let current = ''
  let idx = 0

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    const isHeading = /^#{1,3}\s/.test(trimmed)

    if (
      (isHeading && current.length > 50) ||
      (current.length + trimmed.length + 2 > TARGET_CHARS && current.length > 0)
    ) {
      chunks.push(makeChunk(source, current.trim(), idx++))
      current = ''
    }

    if (trimmed.length > TARGET_CHARS) {
      const sentences = trimmed.split(/(?<=[。！？.!?])\s*/)
      let sentBuf = ''
      for (const sent of sentences) {
        if (sentBuf.length + sent.length + 1 > TARGET_CHARS && sentBuf.length > 0) {
          chunks.push(makeChunk(source, sentBuf.trim(), idx++))
          sentBuf = ''
        }
        sentBuf += (sentBuf ? ' ' : '') + sent
      }
      if (sentBuf.trim()) {
        current = sentBuf.trim()
      }
    } else {
      current += (current ? '\n\n' : '') + trimmed
    }
  }

  if (current.trim()) {
    chunks.push(makeChunk(source, current.trim(), idx++))
  }

  return chunks
}

function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    id: `${source}#${index}`,
    text,
    source,
    index,
  }
}
