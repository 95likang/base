'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type FileUIPart, type UIMessage } from 'ai'
import { ArrowLeft, ImagePlus, Send } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { type ClipboardEvent, type FormEvent, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { GenUIPart, isGenUIPart } from '@/genui/render'
import { isRoadmapPart, RoadmapPart } from '@/roadmap/RoadmapPart'
import { contextCommand } from '../commands/context'
import { dreamCommand, lintCommand, memoryCommand } from '../commands/memory'
import {
  type ChatPanelView,
  type ContextSnapshot,
  createDispatcher,
  type LintReport,
  type MemoryItem,
  type UsageTotals,
} from '../commands/types'
import { usageCommand } from '../commands/usage'

const API = 'http://localhost:3000'

const fmt = (n: number) => n.toLocaleString('en-US')

/** 斜杠命令 dispatcher：模块级组装一次，命令只依赖传入的 CommandContext */
const dispatch = createDispatcher([
  contextCommand,
  usageCommand,
  memoryCommand,
  lintCommand,
  dreamCommand,
])

/** 图片长边降采样上限（Anthropic 推荐值），控制 data URL / DB / 每轮重放历史的体积 */
const MAX_IMAGE_EDGE = 1568

/** 单条消息图片数上限：data URL 随全量历史每轮重放并落库，需控制体积 */
const MAX_IMAGES = 8

/** File → FileUIPart：canvas 降采样 + 转 JPEG data URL（透明区垫白，GIF 取首帧） */
async function fileToImagePart(file: File): Promise<FileUIPart> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return {
    type: 'file',
    mediaType: 'image/jpeg',
    filename: file.name,
    url: canvas.toDataURL('image/jpeg', 0.85),
  }
}

/** 对话详情：按路由 id 加载历史，页内续聊。 */
export default function ChatDetailPage() {
  const { id: chatId } = useParams<{ id: string }>()
  // 记录"哪个会话的历史已加载"。useChat 的 messages 只在首次挂载生效，
  // 必须等历史就绪后才渲染 ChatPanel，否则会带着上一个会话的消息重挂载。
  const [history, setHistory] = useState<{
    chatId: string | null
    messages: UIMessage[]
  }>({
    chatId: null,
    messages: [],
  })

  const [loadError, setLoadError] = useState(false)

  // 按路由 id 拉历史
  useEffect(() => {
    let cancelled = false
    setLoadError(false)
    fetch(`${API}/api/chats/${chatId}/messages`)
      .then((res) => {
        if (!res.ok) throw new Error(`加载历史失败（${res.status}）`)
        return res.json()
      })
      .then((data) => {
        if (!cancelled) setHistory({ chatId, messages: data.messages ?? [] })
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [chatId])

  if (loadError) {
    return (
      <main className="flex flex-col gap-4 p-6 text-sm">
        <p className="text-destructive">会话不存在或加载失败。</p>
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link href="/chat">返回对话列表</Link>
        </Button>
      </main>
    )
  }

  // 历史还没加载完前不渲染 ChatPanel（useChat 的 messages 只在首挂载生效）
  if (history.chatId !== chatId) {
    return <main className="p-6 text-sm text-muted-foreground">加载历史…</main>
  }

  return (
    <main className="flex h-full flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b-2 border-foreground bg-card px-4 py-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/chat">
            <ArrowLeft />
            对话
          </Link>
        </Button>
      </header>

      <ChatPanel key={chatId} chatId={chatId} initialMessages={history.messages} />
    </main>
  )
}

function ChatPanel({ chatId, initialMessages }: { chatId: string; initialMessages: UIMessage[] }) {
  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({
      api: `${API}/api/chat`,
      body: { chatId },
    }),
    messages: initialMessages,
  })
  const [input, setInput] = useState('')
  // 待发送图片（data URL，可直接预览；sendMessage 接受 FileUIPart[]）
  const [images, setImages] = useState<FileUIPart[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 斜杠命令的面板数据（本地展示，不入消息流、不落库）
  const [panel, setPanel] = useState<ChatPanelView | null>(null)

  /** 追加图片：非 image/* 的文件静默忽略；损坏图片跳过并警告，不阻塞其他图片 */
  const addImages = async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    const settled = await Promise.allSettled(imageFiles.map(fileToImagePart))
    const parts = settled
      .filter((r): r is PromiseFulfilledResult<FileUIPart> => r.status === 'fulfilled')
      .map((r) => r.value)
    for (const r of settled) {
      if (r.status === 'rejected') console.warn('图片转换失败，已跳过:', r.reason)
    }
    if (parts.length === 0) return
    setImages((prev) => [...prev, ...parts].slice(0, MAX_IMAGES))
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const cmd = input.trim()
    if (status !== 'ready') return
    // 有图片时不走斜杠命令，按普通消息发送
    if (cmd && images.length === 0) {
      const handled = await dispatch(cmd, {
        chatId,
        showPanel: setPanel,
        send: (text) => void sendMessage({ text }),
      })
      if (handled) {
        setInput('')
        return
      }
    }
    if (!cmd && images.length === 0) return
    // 纯图发送时 text 传 undefined，避免产生空白 text part（会绕过网关识图修复）
    sendMessage({ text: cmd || undefined, files: images })
    setInput('')
    setImages([])
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const files = Array.from(e.clipboardData.files)
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault()
      void addImages(files)
    }
  }

  const busy = status === 'submitted' || status === 'streaming'

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {panel?.kind === 'context' && (
          <ContextPanel snapshot={panel.snapshot} onClose={() => setPanel(null)} />
        )}
        {panel?.kind === 'usage' && (
          <UsagePanel totals={panel.totals} title={panel.title} onClose={() => setPanel(null)} />
        )}
        {panel?.kind === 'memory' && (
          <MemoryPanel items={panel.items} onClose={() => setPanel(null)} />
        )}
        {panel?.kind === 'lint' && (
          <LintPanel total={panel.total} reports={panel.reports} onClose={() => setPanel(null)} />
        )}
        {messages.map((message) => {
          const reasoning = message.parts
            .filter((part) => part.type === 'reasoning')
            .map((part) => part.text)
            .join('')
          return (
            <div
              key={message.id}
              className={`rounded-2xl border-2 px-3 py-2 text-sm ${
                message.role === 'user'
                  ? 'border-foreground bg-accent text-accent-foreground shadow-pop-sm'
                  : 'border-border bg-card text-card-foreground'
              }`}
            >
              <p className="mb-1 text-xs opacity-60">{message.role === 'user' ? '你' : 'AI'}</p>
              {reasoning && (
                <details className="mb-2 rounded-md bg-background/30 px-2 py-1 text-sm">
                  <summary className="cursor-pointer select-none text-xs opacity-60">
                    思考过程
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap">{reasoning}</p>
                </details>
              )}
              {/* 按 parts 顺序渲染：文本段落与卡片保持模型输出的先后关系 */}
              {message.parts.map((part, i) => {
                if (part.type === 'text') {
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: part 没有稳定 id，顺序即身份
                    <p key={`text:${i}`} className="whitespace-pre-wrap">
                      {part.text}
                    </p>
                  )
                }
                if (part.type === 'file' && part.mediaType.startsWith('image/')) {
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同一图片可重复出现，需索引区分
                    <span key={`file:${i}:${part.url}`} className="mb-2 block">
                      {/* biome-ignore lint/performance/noImgElement: data URL 本地图片，next/image 优化无意义 */}
                      <img
                        src={part.url}
                        alt={part.filename ?? '图片'}
                        className="max-h-48 rounded"
                      />
                    </span>
                  )
                }
                if (isGenUIPart(part)) {
                  return (
                    <div key={`genui:${part.toolCallId ?? i}`} className="my-2">
                      <GenUIPart part={part} />
                    </div>
                  )
                }
                if (isRoadmapPart(part)) {
                  // AI SDK 的 tool part 联合由已知工具名生成，这里用 in 收窄取 id
                  const toolCallId = 'toolCallId' in part ? part.toolCallId : undefined
                  return (
                    <div key={`roadmap:${toolCallId ?? i}`} className="my-2">
                      <RoadmapPart part={part} />
                    </div>
                  )
                }
                return null
              })}
            </div>
          )
        })}
        {status === 'submitted' && <p className="text-sm text-muted-foreground">思考中…</p>}
        {error && <p className="text-sm text-destructive">出错了：{error.message}</p>}
      </div>

      <div className="shrink-0 border-t-2 border-foreground bg-card px-3 py-2">
        {busy ? (
          <Button variant="outline" className="w-full" onClick={() => stop()}>
            停止生成
          </Button>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-2">
            {/* 发送前缩略图预览 */}
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {images.map((part, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同一图片可重复添加，url 可能重复，需索引区分
                  <div key={`${i}:${part.url}`} className="relative h-16 w-16">
                    {/* biome-ignore lint/performance/noImgElement: data URL 本地图片，next/image 优化无意义 */}
                    <img
                      src={part.url}
                      alt={part.filename ?? '待发送图片'}
                      className="h-full w-full rounded-xl border-2 border-foreground object-cover"
                    />
                    <button
                      type="button"
                      aria-label="移除图片"
                      onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                      className="absolute -right-1 -top-1 rounded-full bg-foreground px-1 text-xs leading-4 text-background"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void addImages(Array.from(e.target.files ?? []))
                  e.target.value = '' // 重置以允许重复选择同一文件
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="上传图片"
                title="上传图片（也可直接粘贴）"
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus />
              </Button>
              <Input
                className="flex-1"
                placeholder="说点什么…（支持图片与 / 命令）"
                title="支持粘贴/上传图片 · /context 上下文 · /usage 成本 · /memory 记忆 · /lint 体检 · /dream 整理"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={onPaste}
                enterKeyHint="send"
              />
              <Button
                type="submit"
                size="icon"
                aria-label="发送"
                disabled={(!input.trim() && images.length === 0) || status !== 'ready'}
              >
                <Send />
              </Button>
            </div>
          </form>
        )}
      </div>
    </section>
  )
}

/** 上下文占用面板：输入 /context 时展示在消息区顶部（可关闭） */
function ContextPanel({ snapshot, onClose }: { snapshot: ContextSnapshot; onClose: () => void }) {
  return (
    <div className="rounded-xl border-2 border-foreground bg-card p-4 text-sm shadow-pop-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">
          Context · {snapshot.modelId} · 窗口 {fmt(snapshot.windowTokens)} tokens
        </p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {snapshot.sections.map((section) => (
          <div key={section.name} className="flex items-center gap-2">
            <span className="w-32 shrink-0 truncate text-xs text-gray-600" title={section.name}>
              {section.name}
            </span>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums">
              {fmt(section.tokens)}
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded bg-gray-100">
              <div
                className="h-full rounded bg-gray-400"
                style={{
                  width: `${Math.min(100, (section.tokens / snapshot.windowTokens) * 100)}%`,
                }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-gray-500">
              {((section.tokens / snapshot.windowTokens) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t pt-2 text-xs text-gray-600">
        已用 <span className="font-medium text-gray-900">{fmt(snapshot.usedTokens)}</span>（
        {snapshot.usedPercent}%）· 剩余 {fmt(snapshot.freeTokens)} tokens
      </div>
    </div>
  )
}

/** 成本用量面板：输入 /usage（当前会话）或 /usage all（进程累计）时展示 */
function UsagePanel({
  totals,
  title,
  onClose,
}: {
  totals: UsageTotals
  title: string
  onClose: () => void
}) {
  const savedPct =
    totals.baselineCost > 0 ? Math.round((totals.savedCost / totals.baselineCost) * 100) : 0
  const rows = [
    { label: 'input', value: totals.inputTokens },
    { label: 'cache 写入', value: totals.cacheWriteTokens },
    { label: 'cache 读取', value: totals.cacheReadTokens },
    { label: 'output', value: totals.outputTokens },
  ]
  const max = Math.max(...rows.map((r) => r.value), 1)

  return (
    <div className="rounded-xl border-2 border-foreground bg-card p-4 text-sm shadow-pop-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">
          Usage · {title} {fmt(totals.steps)} 步
        </p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-gray-600">{row.label}</span>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums">{fmt(row.value)}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded bg-gray-100">
              <div
                className="h-full rounded bg-gray-400"
                style={{ width: `${(row.value / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t pt-2 text-xs text-gray-600">
        cache 命中率{' '}
        <span className="font-medium text-gray-900">{(totals.hitRate * 100).toFixed(1)}%</span>
        {' · '}花费 <span className="font-medium text-gray-900">${totals.cost.toFixed(4)}</span>
        {' · '}无 cache 假想 ${totals.baselineCost.toFixed(4)}
        {' · '}省 <span className="font-medium text-gray-900">${totals.savedCost.toFixed(4)}</span>
        {savedPct > 0 ? ` (-${savedPct}%)` : ''}
      </div>
    </div>
  )
}

/** 记忆管理面板：输入 /memory 时展示，按四类分组，支持删除 */
function MemoryPanel({ items, onClose }: { items: MemoryItem[]; onClose: () => void }) {
  const [list, setList] = useState(items)

  const remove = async (id: string) => {
    await fetch(`${API}/api/memory/${id}`, { method: 'DELETE' })
    setList((prev) => prev.filter((m) => m.id !== id))
  }

  const labels: Record<MemoryItem['type'], string> = {
    user: '用户画像',
    feedback: '行为反馈',
    project: '项目动态',
    reference: '外部资源',
  }
  const groups = (['user', 'feedback', 'project', 'reference'] as const).map((type) => ({
    type,
    entries: list.filter((m) => m.type === type),
  }))

  return (
    <div className="rounded-xl border-2 border-foreground bg-card p-4 text-sm shadow-pop-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">Memory · 共 {list.length} 条</p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      {list.length === 0 && (
        <p className="text-xs text-gray-500">
          还没有任何记忆。对话中透露偏好/决策/渠道时，AI 会自动保存。
        </p>
      )}
      <div className="flex flex-col gap-3">
        {groups
          .filter((g) => g.entries.length > 0)
          .map((group) => (
            <div key={group.type}>
              <p className="mb-1 text-xs font-medium text-gray-500">{labels[group.type]}</p>
              <div className="flex flex-col gap-1.5">
                {group.entries.map((m) => {
                  const expired = m.expiresAt !== null && new Date(m.expiresAt) < new Date()
                  return (
                    <div
                      key={m.id}
                      className="group flex items-start gap-2 rounded bg-gray-50 px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium" title={m.name}>
                          {m.name}
                          {expired && <span className="ml-1 text-gray-400">（已过期）</span>}
                        </p>
                        <p className="truncate text-xs text-gray-500" title={m.description}>
                          {m.description}
                          {m.expiresAt && !expired ? ` · 截止 ${m.expiresAt.slice(0, 10)}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label="删除记忆"
                        onClick={() => remove(m.id)}
                        className="shrink-0 text-gray-300 hover:text-red-600"
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

/** 记忆体检面板：输入 /lint 时展示，列出每条记忆的失效路径、长期未读、同名重复 */
function LintPanel({
  total,
  reports,
  onClose,
}: {
  total: number
  reports: LintReport[]
  onClose: () => void
}) {
  return (
    <div className="rounded-xl border-2 border-foreground bg-card p-4 text-sm shadow-pop-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">
          记忆体检 · 共 {total} 条
          {reports.length > 0 ? ` · ${reports.length} 条有警告` : ' · 未发现问题'}
        </p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      {reports.length === 0 && (
        <p className="text-xs text-gray-500">
          记忆库健康。体检项：引用路径是否还存在、是否已过期、是否长期未被读取、是否有同名重复。
        </p>
      )}
      <div className="flex flex-col gap-2">
        {reports.map((report) => (
          <div key={report.entry.id} className="rounded bg-amber-50 px-2 py-1.5 text-xs">
            <p className="font-medium">
              [{report.entry.type}] {report.entry.name}
            </p>
            {report.issues.map((issue) => (
              <p key={`${issue.kind}:${issue.message}`} className="text-gray-600">
                · {issue.kind}：{issue.message}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
