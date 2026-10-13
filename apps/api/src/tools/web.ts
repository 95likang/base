import { existsSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { extname, join, sep } from 'node:path'
import TurndownService from 'turndown'
import type { ToolDefinition } from '../lib/tool-registry'
import { WORKSPACE_ROOT } from './filesystem'

/** HTML → Markdown 转换器：剥离噪音标签，标题/代码块用 ATX/fenced 风格 */
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe'])

/** 模拟网页内容（命中前缀直接返回，真实 URL 走下方 fetch 逻辑） */
const MOCK_PAGES: Record<string, string> = {
  'https://example.com/':
    'Example Domain. 这是一个演示用页面：本工具会把 HTML 转换为 Markdown 返回给模型阅读。',
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    '抓取指定 URL 的网页内容并转换为 Markdown（保留标题、链接、代码块结构）。搭配 web_search 使用——先搜索拿到链接，再用这个工具读取详细内容',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ url }: { url: string }) => {
    if (!/^https?:\/\//.test(url)) return '错误：URL 必须以 http:// 或 https:// 开头'

    for (const key of Object.keys(MOCK_PAGES)) {
      if (url.startsWith(key)) return MOCK_PAGES[key]
    }

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 SuperAgent' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return `请求失败：HTTP ${res.status}`

      const html = await res.text()
      // 空结果兜底：纯脚本/纯媒体页面转不出 Markdown
      return turndown.turndown(html).trim() || '页面无文本内容'
    } catch (err) {
      const e = err as { message?: string }
      return `抓取失败：${e.message ?? String(err)}`
    }
  },
}

// ── Vibe Coding 配套：起一个静态服务器把 app/ 暴露到 localhost ──

let previewServer: Server | null = null
let previewPort = 8080

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description:
    '启动 app/ 目录的预览服务器，让浏览器能访问生成的网页应用。生成应用文件后必须立即调用此工具',
  parameters: {
    type: 'object',
    properties: {
      port: { type: 'number', description: '端口号，默认 8080' },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number }) => {
    const root = join(WORKSPACE_ROOT, 'app')
    if (!existsSync(root)) return '错误：app/ 目录不存在，请先用 write_file 生成应用文件'

    if (previewServer) return `预览服务器已在运行 → http://localhost:${previewPort}`

    previewPort = port
    const server = createServer((req, res) => {
      let urlPath: string
      try {
        urlPath = decodeURIComponent(req.url?.split('?')[0] ?? '/')
      } catch {
        res.writeHead(400)
        res.end('Bad Request')
        return
      }
      if (urlPath.endsWith('/')) urlPath += 'index.html'

      const filePath = join(root, urlPath)
      // 目录穿越守卫：解析后必须仍在 root 之下（与文件工具的工作区守卫同语义）
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      try {
        const content = readFileSync(filePath)
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(content)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })

    return new Promise<string>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // 不把失败的 server 存入 previewServer：留 null 允许后续换端口重试
          resolve(`端口 ${port} 已被占用，预览可能已经在跑了，可换一个端口重试`)
        } else {
          reject(err)
        }
      })
      server.listen(port, () => {
        previewServer = server
        resolve(`✓ 预览服务器已启动 → http://localhost:${port}（点击 Sandbox 的 Preview 标签查看）`)
      })
    })
  },
}
