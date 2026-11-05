'use client'

import {
  PRACTICE_ROADMAP_TOOL_NAME,
  parseRoadmapContent,
  type RoadmapContent,
} from 'api/roadmap/spec'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

/** UI 消息里 tool part 的最小形状（AI SDK 的联合类型在这里不需要细分） */
type RoadmapPartShape = {
  type: string
  toolCallId?: string
  state?: string
  input?: unknown
}

/** 路线图候选：名字与工具共用 spec 里的常量，避免两处字符串漂移 */
export function isRoadmapPart(part: { type: string }): part is RoadmapPartShape {
  return part.type === `tool-${PRACTICE_ROADMAP_TOOL_NAME}`
}

function RoadmapSkeleton() {
  return (
    <div
      role="status"
      className="h-40 w-full animate-pulse rounded-lg border border-dashed bg-gray-50"
      aria-label="正在生成训练路线图"
    />
  )
}

function RoadmapFailure({ detail }: { detail: string }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      训练路线图：{detail}
    </div>
  )
}

type RoadmapSessionData = RoadmapContent['phases'][number]['sessions'][number]

/**
 * 完成一次训练：展开输入框 → 提交给接口 → 由服务端生成建议并落库。
 * 只有「我的计划」详情页传入 roadmapId 时才渲染，对话内的卡片保持只读。
 */
function SessionActions({
  roadmapId,
  phaseIndex,
  sessionIndex,
  session,
}: {
  roadmapId: string
  phaseIndex: number
  sessionIndex: number
  session: RoadmapSessionData
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (session.status === 'done') {
    return (
      <div className="mt-2 rounded border border-green-200 bg-green-50 p-2 text-green-900">
        <p className="font-medium">已完成</p>
        {session.completionNote ? <p className="mt-1">完成说明：{session.completionNote}</p> : null}
        {session.feedback ? (
          <p className="mt-1 whitespace-pre-wrap">教练建议：{session.feedback}</p>
        ) : null}
      </div>
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 rounded border px-2 py-1 hover:bg-gray-50"
      >
        完成这次
      </button>
    )
  }

  const submit = async () => {
    const text = note.trim()
    if (!text) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/roadmaps/${roadmapId}/sessions/${phaseIndex}/${sessionIndex}/complete`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: text }),
        },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string }
        } | null
        throw new Error(body?.error?.message ?? '提交失败，请重试')
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请重试')
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-2 rounded border bg-gray-50 p-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="这次完成了什么？哪里卡住了？"
        className="w-full rounded border p-1 text-xs"
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !note.trim()}
          className="rounded bg-black px-2 py-1 text-white disabled:opacity-40"
        >
          {submitting ? '生成建议中…' : '提交'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={submitting}
          className="rounded border px-2 py-1"
        >
          取消
        </button>
        {error ? <span className="text-red-600">{error}</span> : null}
      </div>
    </div>
  )
}

/**
 * 两级路线图卡片：阶段 → 阶段内每次训练。
 * 只有当前阶段高亮，其余置灰标「未激活」——路线图给全局，执行仍只攻一个单点。
 * 导出给「我的计划」详情页复用；传入 roadmapId 时每次训练可标记完成。
 */
export function RoadmapCard({
  content,
  roadmapId,
}: {
  content: RoadmapContent
  roadmapId?: string
}) {
  return (
    <div className="rounded-lg border bg-white p-4 text-xs">
      <div className="mb-3">
        <p className="text-sm font-semibold">{content.title}</p>
        <p className="mt-1 text-gray-600">目标：{content.goal}</p>
        {content.summary ? <p className="mt-1 text-gray-600">概述：{content.summary}</p> : null}
        {content.overallDuration || content.sessionsPerWeek || content.sessionMinutes ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-gray-500">
            {content.startDate && content.endDate ? (
              <span>
                {content.startDate} 至 {content.endDate}
              </span>
            ) : null}
            {content.overallDuration ? <span>总周期：{content.overallDuration}</span> : null}
            {content.sessionsPerWeek ? <span>每周 {content.sessionsPerWeek} 次</span> : null}
            {content.sessionMinutes ? <span>每次 {content.sessionMinutes} 分钟</span> : null}
          </div>
        ) : null}
      </div>
      <ol className="space-y-3">
        {content.phases.map((phase, phaseIndex) => {
          const active = phaseIndex === content.currentPhaseIndex
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: 阶段没有稳定 id，顺序即身份
              key={phaseIndex}
              className={
                active
                  ? 'rounded-lg border border-blue-300 bg-blue-50/40 p-3'
                  : 'rounded-lg border border-dashed p-3 opacity-60'
              }
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">
                  阶段 {phaseIndex + 1} · {phase.title}
                </p>
                <span
                  className={
                    active
                      ? 'rounded bg-blue-600 px-1.5 py-0.5 text-white'
                      : 'rounded bg-gray-200 px-1.5 py-0.5 text-gray-600'
                  }
                >
                  {active ? '当前阶段' : '未激活'}
                </span>
              </div>
              <dl className="mt-2 space-y-1 text-gray-700">
                <div>
                  <dt className="inline text-gray-500">阶段目标：</dt>
                  <dd className="inline">{phase.goal}</dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">单点：</dt>
                  <dd className="inline">{phase.focus}</dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">判据：</dt>
                  <dd className="inline">{phase.criteria}</dd>
                </div>
              </dl>
              <ol className="mt-2 space-y-2">
                {phase.sessions.map((session, sessionIndex) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: 训练没有稳定 id，顺序即身份
                    key={sessionIndex}
                    className="rounded border bg-white/70 p-2"
                  >
                    <p className="font-medium">
                      {sessionIndex + 1}. {session.subskill}
                    </p>
                    {session.date && session.startTime && session.endTime ? (
                      <p className="mt-1 text-gray-500">
                        {session.date} {session.startTime}–{session.endTime}
                      </p>
                    ) : null}
                    <p className="mt-1">{session.task}</p>
                    <p className="mt-1 text-gray-500">
                      算成：{session.criteria} · {session.minutes} 分钟
                    </p>
                    <p className="text-gray-500">产物：{session.product}</p>
                    {roadmapId ? (
                      <SessionActions
                        roadmapId={roadmapId}
                        phaseIndex={phaseIndex}
                        sessionIndex={sessionIndex}
                        session={session}
                      />
                    ) : null}
                  </li>
                ))}
              </ol>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * 一个 part 走完「校验 → 重建 → 渲染」。
 * 只在 output-available 时画正式卡片：此时写库已经成功，
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

  return <RoadmapCard content={content} />
}
