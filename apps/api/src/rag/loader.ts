import { extname } from 'node:path'
import { extractText as extractPdfText } from 'unpdf'

/**
 * 用户输入问题（内容为空、类型不支持、扫描件无文本层）：
 * 路由层据此返回 400，其余异常视为服务端故障。
 */
export class InvalidDocumentError extends Error {}

/**
 * 文档加载：按扩展名把二进制转成纯文本。
 * 支持 .md / .txt（UTF-8）与 .pdf（unpdf 提取，扫描件无文本层会明确报错）。
 */
export async function loadDocument(source: string, data: Uint8Array): Promise<string> {
  const ext = extname(source).toLowerCase()

  if (ext === '.md' || ext === '.txt') {
    const text = new TextDecoder().decode(data)
    if (!text.trim()) throw new InvalidDocumentError('文件内容为空')
    return text
  }

  if (ext === '.pdf') {
    const { text } = await extractPdfText(data, { mergePages: true })
    if (!text.trim()) throw new InvalidDocumentError('PDF 未提取到文本，可能是扫描件')
    return text
  }

  throw new InvalidDocumentError(
    `不支持的文件类型: ${ext || '(无扩展名)'}，仅支持 .md / .txt / .pdf`,
  )
}
