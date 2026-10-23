import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { client, readError } from './lib/api'

interface SearchHit {
  id: string
  source: string
  text: string
  score: number
  vectorScore: number
  keywordScore: number
}

const DOCS_KEY = ['rag', 'documents']
const API_BASE = import.meta.env.VITE_API_URL ?? ''

/**
 * 知识库管理页：上传/路径导入、文档列表、删除、检索预览。
 * 数据源为 /api/rag；上传走原生 fetch（multipart），其余走 Hono RPC。
 */
export function RagPage() {
  const queryClient = useQueryClient()
  const [workspacePath, setWorkspacePath] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)

  const docsQuery = useQuery({
    queryKey: DOCS_KEY,
    queryFn: async () => {
      const res = await client.api.rag.documents.$get()
      if (!res.ok) throw new Error(await readError(res))
      return res.json()
    },
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: DOCS_KEY })

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${API_BASE}/api/rag/upload`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(await readError(res))
      return (await res.json()) as { result: { source: string; chunks: number } }
    },
    onSuccess: (data) => {
      setHits(null)
      refresh()
      window.alert(`已导入 ${data.result.source}（${data.result.chunks} 个片段）`)
    },
  })

  const ingestPath = useMutation({
    mutationFn: async (path: string) => {
      const res = await client.api.rag.ingest.$post({ json: { path } })
      if (!res.ok) throw new Error(await readError(res))
      return res.json()
    },
    onSuccess: () => {
      setWorkspacePath('')
      setHits(null)
      refresh()
    },
  })

  const removeDoc = useMutation({
    mutationFn: async (source: string) => {
      const res = await client.api.rag.documents.$delete({ query: { source } })
      if (!res.ok) throw new Error(await readError(res))
      return res.json()
    },
    onSuccess: () => {
      setHits(null)
      refresh()
    },
  })

  const clearAll = useMutation({
    mutationFn: async () => {
      const res = await client.api.rag.$delete()
      if (!res.ok) throw new Error(await readError(res))
      return res.json()
    },
    onSuccess: () => {
      setHits(null)
      refresh()
    },
  })

  const search = useMutation({
    mutationFn: async (q: string) => {
      const res = await client.api.rag.search.$post({ json: { query: q, topK: 5 } })
      if (!res.ok) throw new Error(await readError(res))
      return res.json()
    },
    onSuccess: (data) => setHits(data.results),
  })

  const onUpload = (file: File | undefined) => {
    if (file) upload.mutate(file)
  }

  const onIngest = (e: FormEvent) => {
    e.preventDefault()
    if (workspacePath.trim()) ingestPath.mutate(workspacePath.trim())
  }

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    if (query.trim()) search.mutate(query.trim())
  }

  const summary = docsQuery.data

  return (
    <main className="mx-auto max-w-4xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">知识库</h1>
        <button
          type="button"
          className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600 disabled:opacity-50"
          disabled={clearAll.isPending || (summary?.totalChunks ?? 0) === 0}
          onClick={() => {
            if (window.confirm('确定清空整个知识库？该操作不可恢复。')) clearAll.mutate()
          }}
        >
          清空知识库
        </button>
      </div>

      <section className="mb-8 grid grid-cols-3 gap-3">
        <Stat label="文档数" value={summary?.totalSources ?? 0} />
        <Stat label="片段数" value={summary?.totalChunks ?? 0} />
        <Stat label="向量模型" value={summary?.model ?? '-'} />
      </section>

      <section className="mb-8 rounded border border-gray-200 p-4">
        <h2 className="mb-3 font-semibold">导入文档</h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-600">上传文件（.md / .txt / .pdf，≤20MB）</span>
            <input
              type="file"
              accept=".md,.txt,.pdf"
              disabled={upload.isPending}
              onChange={(e) => {
                onUpload(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>

          <form onSubmit={onIngest} className="flex gap-2">
            <input
              className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
              placeholder="工作区路径，如 docs/manual.md"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
            />
            <button
              type="submit"
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
              disabled={ingestPath.isPending || !workspacePath.trim()}
            >
              {ingestPath.isPending ? '导入中…' : '按路径导入'}
            </button>
          </form>

          {upload.isPending && <p className="text-sm text-gray-500">上传解析中…</p>}
          {upload.isError && <p className="text-sm text-red-600">{upload.error.message}</p>}
          {ingestPath.isError && <p className="text-sm text-red-600">{ingestPath.error.message}</p>}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 font-semibold">文档列表</h2>
        {docsQuery.isPending && <p className="text-gray-500">加载中…</p>}
        {docsQuery.isError && <p className="text-red-600">加载失败。</p>}
        {summary && summary.documents.length === 0 && (
          <p className="text-gray-500">知识库为空，先上传或导入一份文档。</p>
        )}
        {summary && summary.documents.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-600">
                <th className="py-2 pr-3">来源</th>
                <th className="py-2 pr-3">片段数</th>
                <th className="py-2 pr-3">模型</th>
                <th className="py-2 pr-3">更新时间</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {summary.documents.map((doc) => (
                <tr key={doc.source} className="border-b border-gray-100">
                  <td className="py-2 pr-3 font-medium">{doc.source}</td>
                  <td className="py-2 pr-3">{doc.chunks}</td>
                  <td className="py-2 pr-3 text-gray-500">{doc.model}</td>
                  <td className="py-2 pr-3 text-gray-500">
                    {new Date(doc.updatedAt).toLocaleString()}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      className="text-red-600 underline disabled:opacity-50"
                      disabled={removeDoc.isPending}
                      onClick={() => {
                        if (window.confirm(`删除 ${doc.source} 的全部片段？`)) {
                          removeDoc.mutate(doc.source)
                        }
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {removeDoc.isError && (
          <p className="mt-2 text-sm text-red-600">{removeDoc.error.message}</p>
        )}
        {clearAll.isError && <p className="mt-2 text-sm text-red-600">{clearAll.error.message}</p>}
      </section>

      <section className="rounded border border-gray-200 p-4">
        <h2 className="mb-3 font-semibold">检索预览</h2>
        <form onSubmit={onSearch} className="mb-3 flex gap-2">
          <input
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="输入问题，验证召回效果"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="submit"
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={search.isPending || !query.trim()}
          >
            {search.isPending ? '检索中…' : '检索'}
          </button>
        </form>

        {search.isError && <p className="text-sm text-red-600">{search.error.message}</p>}
        {hits && hits.length === 0 && <p className="text-sm text-gray-500">没有命中任何片段。</p>}
        {hits && hits.length > 0 && (
          <ol className="flex flex-col gap-3">
            {hits.map((hit, i) => (
              <li key={hit.id} className="rounded border border-gray-100 bg-gray-50 p-3">
                <div className="mb-1 text-xs text-gray-500">
                  [{i + 1}] {hit.source} · 综合 {hit.score.toFixed(3)} · 向量{' '}
                  {hit.vectorScore.toFixed(2)} · 关键词 {hit.keywordScore.toFixed(2)}
                </div>
                <p className="whitespace-pre-wrap text-sm">{hit.text}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  )
}
