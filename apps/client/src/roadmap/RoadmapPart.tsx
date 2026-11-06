'use client'

import {
  PRACTICE_ROADMAP_TOOL_NAME,
  parseRoadmapContent,
  type RoadmapContent,
  summarizeRoadmap,
} from 'api/roadmap/spec'
import { CheckCircle2, ChevronDown, RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { dayOffset } from '@/lib/date'
import { ApiError, apiFetch } from '@/lib/http'
import { roadmapMetaLines } from './summary'

/** UI 消息里 tool part 的最小形状（AI SDK 的联合类型在这里不需要细分） */
type RoadmapPartShape = {
  type: string
  state?: string
  input?: unknown
  output?: unknown
}

type SessionData = RoadmapContent['phases'][number]['sessions'][number]

/** 路线图候选：名字与工具共用 spec 里的常量，避免两处字符串漂移 */
export function isRoadmapPart(part: { type: string }): part is RoadmapPartShape {
  return part.type === `tool-${PRACTICE_ROADMAP_TOOL_NAME}`
}

function RoadmapSkeleton() {
  return (
    <div role="status" className="rounded-xl border-2 border-border bg-card p-4 shadow-card">
      <span className="sr-only">正在生成训练路线图…</span>
      <div aria-hidden="true">
        <Skeleton className="h-3 w-24 rounded-sm" />
        <Skeleton className="mt-2 h-5 w-2/3 rounded-sm" />
        <Skeleton className="mt-2 h-4 w-full rounded-sm" />
        <Skeleton className="mt-1.5 h-4 w-4/5 rounded-sm" />
        <Skeleton className="mt-3 h-4 w-1/2 rounded-sm" />
        <Skeleton className="mt-3 h-12 w-full rounded-full" />
      </div>
    </div>
  )
}

function RoadmapFailure({ detail }: { detail: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border-2 border-foreground bg-tertiary/25 px-4 py-3 text-sm leading-relaxed"
    >
      训练路线图：{detail}
    </div>
  )
}

/** 判据可能是一条，也可能是分号隔开的多条；全部列出，避免用户为没看到的内容背书 */
function criteriaLines(criteria: string): string[] {
  return criteria
    .split(/[；;]/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * 完成一次训练：展开输入框 → 提交给接口 → 由服务端生成建议并落库。
 * 只有「我的计划」详情页传入 roadmapId 时才渲染，对话内的卡片保持只读。
 */
function SessionActions({
  roadmapId,
  phaseIndex,
  sessionIndex,
  session,
  locked,
}: {
  roadmapId: string
  phaseIndex: number
  sessionIndex: number
  session: SessionData
  /** 上一场还没完成：按钮置灰，不能越序标记 */
  locked: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const undo = async () => {
    setUndoing(true)
    setError(null)
    try {
      await apiFetch(
        `/api/roadmaps/${encodeURIComponent(roadmapId)}/sessions/${phaseIndex}/${sessionIndex}/uncomplete`,
        { method: 'POST' },
      )
      router.refresh()
    } catch (err) {
      // 401 已在 apiFetch 内跳转登录
      if (err instanceof ApiError && err.status === 401) return
      setError(err instanceof Error ? err.message : '撤销失败，请重试。')
      setUndoing(false)
    }
  }

  if (session.status === 'done') {
    return (
      <div className="mt-3 rounded-md border-2 border-foreground bg-quaternary/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-heading text-sm font-extrabold">
            <CheckCircle2 className="size-4" strokeWidth={2.5} />
            已完成
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-11 text-xs"
            disabled={undoing}
            onClick={undo}
          >
            <RotateCcw className="size-3.5" />
            {undoing ? '撤销中…' : '撤销完成'}
          </Button>
        </div>
        {session.completionNote ? (
          <p className="mt-1.5 text-sm leading-relaxed">完成说明：{session.completionNote}</p>
        ) : null}
        {session.feedback ? (
          <div className="mt-2 rounded-sm border-2 border-border bg-card p-2.5">
            <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
              教练建议
            </p>
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap">{session.feedback}</p>
          </div>
        ) : null}
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </div>
    )
  }

  if (!open) {
    const ahead = dayOffset(session.date)
    return (
      <Button
        variant="outline"
        className="mt-3 w-full"
        disabled={locked}
        onClick={() => setOpen(true)}
      >
        {locked
          ? '完成上一场训练后才能标记这场'
          : ahead !== null && ahead > 0
            ? '提前完成这次'
            : '完成这次'}
      </Button>
    )
  }

  const submit = async () => {
    const text = note.trim()
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch(
        `/api/roadmaps/${encodeURIComponent(roadmapId)}/sessions/${phaseIndex}/${sessionIndex}/complete`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: text }),
        },
      )
      router.refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return
      setError(err instanceof Error ? err.message : '提交失败，请重试。')
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border-2 border-border bg-muted/40 p-3">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="这次完成了什么？没做完也没关系，写清卡在哪。"
        className="min-h-28 w-full rounded-md border-2 border-input bg-card p-2 text-base leading-relaxed outline-none focus-visible:border-accent"
      />
      <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm leading-relaxed">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]"
        />
        上面每条判据都做到了
      </label>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          className="h-12 flex-1"
          onClick={submit}
          disabled={submitting || !note.trim() || !confirmed}
        >
          {submitting ? '教练正在看你的记录…' : '完成并获取建议'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-12"
          onClick={() => setOpen(false)}
          disabled={submitting}
        >
          取消
        </Button>
      </div>
      {!submitting && (!note.trim() || !confirmed) ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {!note.trim() ? '写下这次完成了什么才能提交。' : '确认上面每条判据都做到后即可提交。'}
        </p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}

/**
 * 两级路线图：阶段 → 阶段内每次训练。
 * 默认只展开当前阶段，其余折叠——路线图给全局，执行仍只攻一个单点。
 * 导出给「我的计划」详情页复用；传入 roadmapId 时每次训练可标记完成。
 */
export function RoadmapCard({
  content,
  roadmapId,
  focusPhaseIndex,
  titleAs: Title = 'h2',
}: {
  content: RoadmapContent
  roadmapId?: string
  /** 从列表「查看这次」跳转时，额外展开下一训练所在阶段 */
  focusPhaseIndex?: number
  /** 详情页用 h1，对话内嵌卡片用 h2，避免一页多个 h1 */
  titleAs?: 'h1' | 'h2'
}) {
  const { done, total, percent } = summarizeRoadmap(content)
  const meta = roadmapMetaLines(content)

  // 训练按顺序解锁：上一场没完成时，后面所有「完成」按钮都置灰
  const lockedSessions = new Set<string>()
  let previousDone = true
  for (const [phaseIndex, phase] of content.phases.entries()) {
    for (const [sessionIndex, session] of phase.sessions.entries()) {
      if (!previousDone) lockedSessions.add(`${phaseIndex}-${sessionIndex}`)
      previousDone = session.status === 'done'
    }
  }

  // <details> 的 open 写成受控属性后，用户手动展开会被下次渲染弹回；
  // 用状态记录开关：初始只展开当前阶段与跳转目标阶段。
  const [openPhases, setOpenPhases] = useState<ReadonlySet<number>>(
    () =>
      new Set([
        content.currentPhaseIndex,
        ...(focusPhaseIndex === undefined ? [] : [focusPhaseIndex]),
      ]),
  )
  useEffect(() => {
    setOpenPhases(
      (prev) =>
        new Set([
          ...prev,
          content.currentPhaseIndex,
          ...(focusPhaseIndex === undefined ? [] : [focusPhaseIndex]),
        ]),
    )
  }, [content.currentPhaseIndex, focusPhaseIndex])

  const togglePhase = (phaseIndex: number, opened: boolean) => {
    setOpenPhases((prev) => {
      if (opened === prev.has(phaseIndex)) return prev
      const next = new Set(prev)
      if (opened) next.add(phaseIndex)
      else next.delete(phaseIndex)
      return next
    })
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-xl border-2 border-foreground bg-card p-4 shadow-card">
        <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          训练路线图
        </p>
        <Title className="mt-1 font-heading text-xl leading-snug font-extrabold">
          {content.title}
        </Title>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{content.goal}</p>
        {content.summary ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{content.summary}</p>
        ) : null}

        {meta.length > 0 ? (
          <p className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {meta.map((text) => (
              <span key={text}>{text}</span>
            ))}
          </p>
        ) : null}

        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
              进度
            </span>
            <span className="font-heading text-sm font-extrabold tabular-nums">
              {done} / {total}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="计划完成进度"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="mt-1.5 h-3 overflow-hidden rounded-full border-2 border-foreground bg-muted"
          >
            <div
              className="h-full bg-quaternary transition-[width] duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </header>

      <ol className="flex flex-col gap-3">
        {content.phases.map((phase, phaseIndex) => {
          const active = phaseIndex === content.currentPhaseIndex
          const allDone = phase.sessions.every((session) => session.status === 'done')
          const status = active ? '当前阶段' : allDone ? '已完成' : '未开始'

          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 阶段没有稳定 id，顺序即身份
            <li key={phaseIndex}>
              <details
                open={openPhases.has(phaseIndex)}
                onToggle={(event) => togglePhase(phaseIndex, event.currentTarget.open)}
                className="group rounded-xl border-2 border-foreground bg-card shadow-card"
              >
                <summary className="flex cursor-pointer list-none items-start gap-2 p-4 [&::-webkit-details-marker]:hidden">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
                      阶段 {phaseIndex + 1} / {content.phases.length}
                    </p>
                    <h2 className="mt-0.5 font-heading text-base leading-snug font-extrabold">
                      {phase.title}
                    </h2>
                  </div>
                  <span
                    className={
                      active
                        ? 'shrink-0 rounded-full border-2 border-foreground bg-accent px-2 py-0.5 text-xs font-bold text-accent-foreground'
                        : allDone
                          ? 'shrink-0 rounded-full border-2 border-foreground bg-quaternary px-2 py-0.5 text-xs font-bold'
                          : 'shrink-0 rounded-full border-2 border-border px-2 py-0.5 text-xs font-bold text-muted-foreground'
                    }
                  >
                    {status}
                  </span>
                  <ChevronDown
                    className="mt-1 size-5 shrink-0 transition-transform group-open:rotate-180"
                    strokeWidth={2.5}
                    aria-hidden
                  />
                </summary>

                <div className="flex flex-col gap-3 border-t-2 border-border px-4 py-3">
                  <dl className="grid gap-2 text-sm leading-relaxed">
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 font-bold text-muted-foreground">阶段目标</dt>
                      <dd className="min-w-0">{phase.goal}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 font-bold text-muted-foreground">单点</dt>
                      <dd className="min-w-0">{phase.focus}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 font-bold text-muted-foreground">判据</dt>
                      <dd className="min-w-0">{phase.criteria}</dd>
                    </div>
                  </dl>

                  <p className="text-sm text-muted-foreground">
                    {active
                      ? '先只攻这一个单点；本阶段全部完成后自动进入下一阶段。'
                      : allDone
                        ? '本阶段全部完成。'
                        : '完成上一阶段的全部训练后开始。'}
                  </p>

                  <ol className="flex flex-col gap-3">
                    {phase.sessions.map((session, sessionIndex) => {
                      const completed = session.status === 'done'
                      return (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: 训练没有稳定 id，顺序即身份
                          key={sessionIndex}
                          id={`session-${phaseIndex}-${sessionIndex}`}
                          className={
                            completed
                              ? 'scroll-mt-24 rounded-md border-2 border-foreground bg-quaternary/10 p-3'
                              : 'scroll-mt-24 rounded-md border-2 border-border bg-card p-3'
                          }
                        >
                          <h3 className="font-heading text-sm leading-snug font-extrabold">
                            {sessionIndex + 1}. {session.subskill}
                          </h3>
                          {session.date && session.startTime && session.endTime ? (
                            <p className="mt-1 font-heading text-base font-extrabold tabular-nums">
                              {session.date} {session.startTime}–{session.endTime}
                            </p>
                          ) : null}
                          <p className="mt-1.5 text-sm leading-relaxed">{session.task}</p>

                          <div className="mt-2 rounded-sm border-2 border-border bg-muted/50 p-2.5">
                            <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
                              完成判据
                            </p>
                            <ul className="mt-1 space-y-1 text-sm leading-relaxed">
                              {criteriaLines(session.criteria).map((line) => (
                                <li key={line} className="flex gap-1.5">
                                  <span
                                    aria-hidden
                                    className="mt-2 size-1.5 shrink-0 rounded-full bg-accent"
                                  />
                                  <span className="min-w-0">{line}</span>
                                </li>
                              ))}
                            </ul>
                          </div>

                          <p className="mt-1.5 text-sm text-muted-foreground">
                            产物：{session.product} · {session.minutes} 分钟
                          </p>

                          {roadmapId ? (
                            <SessionActions
                              roadmapId={roadmapId}
                              phaseIndex={phaseIndex}
                              sessionIndex={sessionIndex}
                              session={session}
                              locked={lockedSessions.has(`${phaseIndex}-${sessionIndex}`)}
                            />
                          ) : null}
                        </li>
                      )
                    })}
                  </ol>
                </div>
              </details>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/** 工具返回 { roadmapId }；历史消息里该值可能被存成 JSON 字符串 */
function roadmapIdOf(output: unknown): string | null {
  let value = output
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const id = (value as { roadmapId?: unknown }).roadmapId
  return typeof id === 'string' ? id : null
}

/**
 * 对话内的路线图摘要卡：对话只是生成现场，执行去「我的计划」。
 * 不在这里展示进度——tool part 是生成时快照，和计划页的实时进度会打架。
 */
function RoadmapSummary({
  content,
  roadmapId,
}: {
  content: RoadmapContent
  roadmapId: string | null
}) {
  const { total } = summarizeRoadmap(content)

  return (
    <section className="rounded-xl border-2 border-foreground bg-card p-4 shadow-card">
      <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
        训练路线图已生成
      </p>
      <h2 className="mt-1 font-heading text-lg leading-snug font-extrabold">{content.title}</h2>
      <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
        {content.goal}
      </p>

      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>{content.phases.length} 个阶段</span>
        <span>{total} 次训练</span>
        {content.sessionMinutes ? <span>每次 {content.sessionMinutes} 分钟</span> : null}
        {content.startDate && content.endDate ? (
          <span>
            {content.startDate} 至 {content.endDate}
          </span>
        ) : null}
      </p>

      <Button asChild className="mt-3 w-full">
        <Link href={roadmapId ? `/plans/${roadmapId}` : '/plans'}>打开我的计划</Link>
      </Button>
    </section>
  )
}

/**
 * 一个 part 走完「校验 → 重建 → 渲染」。
 * 只在 output-available 时画卡片：此时写库已经成功，
 * 屏幕上看到的与数据库里的才是同一份。
 */
export function RoadmapPart({ part }: { part: RoadmapPartShape }) {
  if (part.state === 'output-error') {
    return <RoadmapFailure detail="保存失败，请让模型重试。" />
  }

  // 参数还在生成 / 已闭合但工具尚未执行完：一律骨架，不展示半截数据
  if (part.state === 'input-streaming' || part.state === 'input-available') {
    return <RoadmapSkeleton />
  }

  if (part.state !== 'output-available') {
    return <RoadmapFailure detail="数据状态异常，这张路线图未能显示。" />
  }

  const content = parseRoadmapContent(part.input)
  if (!content) {
    return <RoadmapFailure detail="内容格式不合法，这张路线图未能显示。" />
  }

  return <RoadmapSummary content={content} roadmapId={roadmapIdOf(part.output)} />
}
