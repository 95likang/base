import type { ToolDefinition, ToolExecuteOptions } from '../lib/tool-registry'

/** max_results 收紧到 [1, 10]：结果太长只会被截断层丢弃，白花 API 配额 */
function clampMaxResults(n: number): number {
  return Math.min(Math.max(Math.trunc(n) || 5, 1), 10)
}

/** 超时 + 客户端取消信号合并：任一触发即中止外部请求 */
function searchSignal(abortSignal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(15000), abortSignal].filter(Boolean) as AbortSignal[])
}

// ── Tavily（自动挡）──────────────────────────────

export const tavilySearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回相关网页的标题、链接和内容摘要',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async (
    { query, max_results = 5 }: { query: string; max_results?: number },
    { abortSignal }: ToolExecuteOptions,
  ) => {
    const apiKey = process.env.TAVILY_API_KEY
    if (!apiKey) return '[web_search] 未配置 TAVILY_API_KEY，请在 .env 中设置'

    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: clampMaxResults(max_results),
          include_answer: true,
        }),
        signal: searchSignal(abortSignal),
      })

      if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`

      // biome-ignore lint/suspicious/noExplicitAny: Tavily 响应结构随接口版本变化，动态字段按需读取
      const data = (await res.json()) as any
      const lines: string[] = []

      if (data.answer) {
        lines.push(`## AI 摘要\n${data.answer}\n`)
      }

      for (const r of data.results || []) {
        lines.push(`### ${r.title}`)
        lines.push(r.url)
        lines.push(r.content || r.snippet || '')
        lines.push('')
      }

      return lines.join('\n') || '没有找到相关结果'
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return '[web_search] 请求超时（15s），请稍后重试或缩小搜索范围'
      }
      const e = err as { message?: string }
      return `[web_search] 搜索失败：${e.message ?? String(err)}`
    }
  },
}

// ── Serper（手动挡）──────────────────────────────

export const serperSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async (
    { query, max_results = 5 }: { query: string; max_results?: number },
    { abortSignal }: ToolExecuteOptions,
  ) => {
    const apiKey = process.env.SERPER_API_KEY
    if (!apiKey) return '[web_search] 未配置 SERPER_API_KEY，请在 .env 中设置'

    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: clampMaxResults(max_results) }),
        signal: searchSignal(abortSignal),
      })

      if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`

      // biome-ignore lint/suspicious/noExplicitAny: Serper 响应结构随接口版本变化，动态字段按需读取
      const data = (await res.json()) as any
      const lines: string[] = []

      // Knowledge Graph（如果有）
      if (data.knowledgeGraph) {
        const kg = data.knowledgeGraph
        lines.push(`## ${kg.title}`)
        if (kg.description) lines.push(kg.description)
        lines.push('')
      }

      // Organic Results
      for (const r of (data.organic || []).slice(0, clampMaxResults(max_results))) {
        lines.push(`### ${r.title}`)
        lines.push(r.link)
        lines.push(r.snippet || '')
        lines.push('')
      }

      return lines.join('\n') || '没有找到相关结果'
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return '[web_search] 请求超时（15s），请稍后重试或缩小搜索范围'
      }
      const e = err as { message?: string }
      return `[web_search] 搜索失败：${e.message ?? String(err)}`
    }
  },
}

// ── 根据环境变量选择搜索后端 ──────────────────────────────

export function pickSearchTool(): ToolDefinition {
  if (process.env.TAVILY_API_KEY) return tavilySearchTool
  if (process.env.SERPER_API_KEY) return serperSearchTool
  // 都没配就返回 tavily 版（会提示配置 API Key）
  return tavilySearchTool
}
