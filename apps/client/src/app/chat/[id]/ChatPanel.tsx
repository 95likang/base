'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type FileUIPart, type UIMessage } from 'ai'
import { ImagePlus, Send } from 'lucide-react'
import { type ClipboardEvent, type FormEvent, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { GenUIPart, isGenUIPart } from '@/genui/render'
import { redirectToLogin } from '@/lib/auth-redirect'
import { fileToImagePart, MAX_IMAGE_FILE_SIZE, MAX_IMAGES } from '@/lib/image'
import { isRoadmapPart, RoadmapPart } from '@/roadmap/RoadmapPart'
import { contextCommand } from '../commands/context'
import { dreamCommand, lintCommand, memoryCommand } from '../commands/memory'
import { type ChatPanelView, createDispatcher } from '../commands/types'
import { usageCommand } from '../commands/usage'
import { markdownComponents } from './markdown'
import { ContextPanel, LintPanel, MemoryPanel, UsagePanel } from './panels'

/** 斜杠命令 dispatcher：模块级组装一次，命令只依赖传入的 CommandContext */
const dispatch = createDispatcher([
  contextCommand,
  usageCommand,
  memoryCommand,
  lintCommand,
  dreamCommand,
])

/** 对话面板：消息流 + 输入区 + 本地命令面板（命令不入消息流、不落库） */
export function ChatPanel({
  chatId,
  initialMessages,
}: {
  chatId: string
  initialMessages: UIMessage[]
}) {
  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: { chatId },
      // 会话过期时 API 返回 401：直接回登录页，不停在“发送失败，请检查网络”
      fetch: async (input, init) => {
        const res = await fetch(input, init)
        if (res.status === 401) redirectToLogin(`/chat/${chatId}`)
        return res
      },
    }),
    messages: initialMessages,
  })
  const [input, setInput] = useState('')
  // 待发送图片（data URL，可直接预览；sendMessage 接受 FileUIPart[]）
  const [images, setImages] = useState<FileUIPart[]>([])
  const [imageNotice, setImageNotice] = useState('')
  const [commandError, setCommandError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 斜杠命令的面板数据（本地展示，不入消息流、不落库）
  const [panel, setPanel] = useState<ChatPanelView | null>(null)
  // 消息区滚到底：首次进入与收到新消息时跟随，用户上滑后不打扰
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息或状态变化时要重新滚到底，只读 DOM 尺寸
  useEffect(() => {
    const el = listRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, status])

  /** 追加图片：超大/损坏的图片跳过并提示，不阻塞其他图片 */
  const addImages = async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    setImageNotice('')

    const oversized = imageFiles.filter((f) => f.size > MAX_IMAGE_FILE_SIZE)
    if (oversized.length > 0) {
      setImageNotice(`有 ${oversized.length} 张图片超过 15MB，已跳过。`)
    }

    const decodable = imageFiles.filter((f) => f.size <= MAX_IMAGE_FILE_SIZE)
    const settled = await Promise.allSettled(decodable.map(fileToImagePart))
    const parts = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const broken = settled.length - parts.length
    if (broken > 0) {
      setImageNotice((prev) => prev || `有 ${broken} 张图片无法读取，已跳过。`)
    }
    if (parts.length === 0) return

    const room = MAX_IMAGES - images.length
    if (room <= 0) {
      setImageNotice(`单条消息最多 ${MAX_IMAGES} 张图片。`)
      return
    }
    if (parts.length > room) {
      setImageNotice(`单条消息最多 ${MAX_IMAGES} 张图片，多余的已忽略。`)
    }
    setImages((prev) => [...prev, ...parts.slice(0, room)])
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const cmd = input.trim()
    if (status !== 'ready') return
    setCommandError('')
    // 有图片时不走斜杠命令，按普通消息发送
    if (cmd && images.length === 0) {
      try {
        const handled = await dispatch(cmd, {
          chatId,
          showPanel: setPanel,
          send: (text) => void sendMessage({ text }),
        })
        if (handled) {
          setInput('')
          return
        }
      } catch (err) {
        // 401 已在 apiFetch 内跳转登录，这里只负责提示其余失败
        setCommandError(err instanceof Error ? err.message : '命令执行失败，请重试。')
        return
      }
    }
    if (!cmd && images.length === 0) return
    // 纯图发送时 text 传 undefined，避免产生空白 text part（会绕过网关识图修复）
    sendMessage({ text: cmd || undefined, files: images })
    setInput('')
    setImages([])
    setImageNotice('')
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
      <div
        ref={listRef}
        onScroll={() => {
          const el = listRef.current
          if (!el) return
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        role="log"
        aria-label="对话消息"
      >
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
        {commandError ? (
          <p
            role="alert"
            className="rounded-xl border-2 border-destructive bg-card px-4 py-3 text-sm leading-relaxed text-destructive"
          >
            {commandError}
          </p>
        ) : null}
        {messages.map((message) => {
          // 思考过程默认折叠，点击展开；仍在生成的回复在标题旁给出脉冲提示
          const isLatestAssistant =
            message.role === 'assistant' && message.id === messages[messages.length - 1]?.id
          return (
            <div
              key={message.id}
              className={`rounded-2xl border-2 px-3 py-2 text-sm ${
                message.role === 'user'
                  ? 'border-foreground bg-accent text-accent-foreground shadow-pop-sm'
                  : 'border-border bg-card text-card-foreground'
              }`}
            >
              <p
                className={`mb-1 text-xs font-bold ${
                  message.role === 'user' ? 'text-accent-foreground' : 'text-muted-foreground'
                }`}
              >
                {message.role === 'user' ? '你' : 'AI'}
              </p>
              {/* 按 parts 顺序渲染：思考过程、文本段落与卡片保持模型输出的先后关系 */}
              {message.parts.map((part, i) => {
                if (part.type === 'reasoning') {
                  if (!part.text.trim()) return null
                  return (
                    <details
                      // biome-ignore lint/suspicious/noArrayIndexKey: reasoning part 无稳定 id，顺序即身份
                      key={`reasoning:${i}`}
                      className="mb-2 rounded-xl border-2 border-border bg-background/60 px-3 py-2 text-sm"
                    >
                      <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-bold text-muted-foreground select-none">
                        {busy && isLatestAssistant && i === message.parts.length - 1 && (
                          <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                        )}
                        思考过程
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">
                        {part.text}
                      </p>
                    </details>
                  )
                }
                if (part.type === 'text') {
                  if (!part.text.trim()) return null
                  return (
                    <Markdown
                      // biome-ignore lint/suspicious/noArrayIndexKey: part 没有稳定 id，顺序即身份
                      key={`text:${i}`}
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {part.text}
                    </Markdown>
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
        {status === 'submitted' && (
          <p className="flex items-center gap-1" role="status" aria-label="等待模型响应">
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:120ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:240ms]" />
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            发送失败，请检查网络后重新发送。
          </p>
        )}
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
            {imageNotice ? (
              <p role="status" className="text-xs text-muted-foreground">
                {imageNotice}
              </p>
            ) : null}
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
