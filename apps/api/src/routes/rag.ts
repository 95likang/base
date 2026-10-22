import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { ApiError, validationHook } from '../lib/api-error'
import { ingestFile } from '../rag/ingest'
import { InvalidDocumentError } from '../rag/loader'
import { hybridSearch } from '../rag/search'
import { ragEmbedder, ragStore } from '../rag/service'
import { listDocuments } from '../rag/store'
import { resolveWorkspacePath, workspaceRelativePath } from '../tools/file-tools'

/** 单文件上传上限：20MB，避免一次请求把内存打满 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
/** multipart 边界与表单字段的额外开销余量 */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024

const ingestSchema = z.object({
  path: z.string().trim().min(1),
})

const searchSchema = z.object({
  query: z.string().trim().min(1),
  topK: z.coerce.number().int().min(1).max(20).default(5),
})

const sourceQuerySchema = z.object({
  source: z.string().trim().min(1),
})

function ingestionError(err: unknown): ApiError {
  const message = err instanceof Error ? err.message : String(err)
  return err instanceof InvalidDocumentError
    ? new ApiError('INVALID_DOCUMENT', message, 400)
    : new ApiError('RAG_INGEST_FAILED', message, 500)
}

/**
 * 知识库管理路由（admin 管理页的数据源）。
 * GET    /documents        文档列表（按 source 聚合）+ 知识库规模
 * POST   /upload           multipart 上传 .md/.txt/.pdf，解析后入库
 * POST   /ingest           按工作区路径导入
 * POST   /search           检索预览（页面验证召回质量）
 * DELETE /documents?source= 删除某文档
 * DELETE /                 清空知识库
 */
export const ragRoute = new Hono()
  .get('/documents', async (c) => {
    // 统计口径与列表同源（DB 全量），避免切换 embedding 模型后数字与表格对不上
    const documents = await listDocuments()
    return c.json({
      documents,
      totalChunks: documents.reduce((sum, doc) => sum + doc.chunks, 0),
      totalSources: documents.length,
      model: ragEmbedder.name,
    })
  })
  .post('/upload', async (c) => {
    // parseBody 会把整个请求体读进内存，先用 Content-Length 粗筛
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
      throw new ApiError('FILE_TOO_LARGE', '文件超过 20MB 上限', 413)
    }

    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) {
      throw new ApiError('FILE_REQUIRED', '缺少 file 字段（multipart/form-data）', 400)
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ApiError('FILE_TOO_LARGE', '文件超过 20MB 上限', 413)
    }

    // 只保留文件名部分：防止客户端伪造 "docs/a.md" 覆盖按路径导入的同名文档
    const source = basename(file.name).trim()
    if (!source) {
      throw new ApiError('FILE_NAME_INVALID', '文件名不能为空', 400)
    }

    const data = new Uint8Array(await file.arrayBuffer())
    try {
      const result = await ingestFile(ragStore, ragEmbedder, source, data)
      return c.json({ result }, 201)
    } catch (err) {
      throw ingestionError(err)
    }
  })
  .post('/ingest', zValidator('json', ingestSchema, validationHook), async (c) => {
    const { path } = c.req.valid('json')
    try {
      const abs = resolveWorkspacePath(path)
      const data = new Uint8Array(readFileSync(abs))
      const result = await ingestFile(ragStore, ragEmbedder, workspaceRelativePath(abs), data)
      return c.json({ result }, 201)
    } catch (err) {
      throw ingestionError(err)
    }
  })
  .post('/search', zValidator('json', searchSchema, validationHook), async (c) => {
    const { query, topK } = c.req.valid('json')
    await ragStore.ensureLoaded()
    const results = await hybridSearch(ragStore, ragEmbedder, query, topK)
    return c.json({
      results: results.map((result) => ({
        id: result.chunk.id,
        source: result.chunk.source,
        text: result.chunk.text,
        score: result.score,
        vectorScore: result.vectorScore,
        keywordScore: result.keywordScore,
      })),
    })
  })
  .delete('/documents', zValidator('query', sourceQuerySchema, validationHook), async (c) => {
    const { source } = c.req.valid('query')
    await ragStore.deleteSource(source)
    return c.json({ ok: true })
  })
  .delete('/', async (c) => {
    await ragStore.clear()
    return c.json({ ok: true })
  })
