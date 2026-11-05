import { parseRoadmapContent } from 'api/roadmap/spec'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { createAuthedServerClient } from '@/lib/api'
import { relativeDay } from '@/lib/date'
import { RoadmapCard } from '@/roadmap/RoadmapPart'
import { DeletePlanButton } from '../DeletePlanButton'

export const dynamic = 'force-dynamic'

/** 计划详情：完整两级路线图 + 返回列表 + 来源会话 + 删除（危险操作单独放底部） */
export default async function PlanDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ phase?: string }>
}) {
  const { id } = await params
  const { phase } = await searchParams
  const focusPhaseIndex = Number.parseInt(phase ?? '', 10)
  const client = await createAuthedServerClient()
  const res = await client.api.roadmaps[':id'].$get({ param: { id } })

  if (res.status === 401) redirect(`/login?redirect=${encodeURIComponent(`/plans/${id}`)}`)
  if (res.status === 404) notFound()
  if (!res.ok) {
    return (
      <main className="flex flex-col gap-4 p-6">
        <h1 className="text-2xl">计划没能加载</h1>
        <p role="alert" className="text-sm leading-relaxed text-muted-foreground">
          可能是网络或服务端出了问题，你的计划没有丢。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <a href={`/plans/${id}`}>重新加载</a>
          </Button>
          <Button asChild variant="outline">
            <Link href="/plans">返回列表</Link>
          </Button>
        </div>
      </main>
    )
  }

  const { roadmap } = await res.json()
  const content = parseRoadmapContent(roadmap.content)
  // 下一次训练：第一个未完成的条目，和「我的计划」列表口径一致
  const next = content
    ? (content.phases
        .flatMap((p, phaseIndex) =>
          p.sessions.map((session, sessionIndex) => ({ session, phaseIndex, sessionIndex })),
        )
        .find(({ session }) => session.status !== 'done') ?? null)
    : null
  const rel = next ? relativeDay(next.session.date) : null

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2 pt-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/plans">
            <ArrowLeft />
            计划
          </Link>
        </Button>
        <Link
          href={`/chat/${roadmap.chatId}`}
          className="text-xs font-bold text-muted-foreground underline-offset-4 hover:underline"
        >
          来源会话
        </Link>
      </header>

      {next ? (
        <div className="sticky top-0 z-10 -mx-4 border-y-2 border-foreground bg-card px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
                本次训练
              </p>
              <p className="flex min-w-0 items-center gap-1.5 font-heading text-sm font-extrabold">
                {rel ? (
                  <span
                    className={
                      rel.overdue
                        ? 'shrink-0 rounded-full border-2 border-destructive px-1.5 text-xs text-destructive'
                        : 'shrink-0 rounded-full border-2 border-foreground bg-quaternary px-1.5 text-xs'
                    }
                  >
                    {rel.label}
                  </span>
                ) : null}
                <span className="truncate">
                  {next.session.date ? `${next.session.date} ` : ''}
                  {next.session.startTime && next.session.endTime
                    ? `${next.session.startTime}–${next.session.endTime} · `
                    : ''}
                  {next.session.subskill}
                </span>
              </p>
            </div>
            <Button asChild size="sm" className="h-11 shrink-0">
              <a href={`#session-${next.phaseIndex}-${next.sessionIndex}`}>去完成</a>
            </Button>
          </div>
        </div>
      ) : null}

      {content ? (
        <RoadmapCard
          content={content}
          roadmapId={roadmap.id}
          focusPhaseIndex={Number.isNaN(focusPhaseIndex) ? undefined : focusPhaseIndex}
          titleAs="h1"
        />
      ) : (
        <p
          role="alert"
          className="rounded-xl border-2 border-tertiary bg-card px-4 py-3 text-sm leading-relaxed"
        >
          计划数据不完整，无法展示。可以回到来源会话让教练重新生成。
        </p>
      )}

      <div className="flex justify-end border-t-2 border-border pt-3">
        <DeletePlanButton id={roadmap.id} redirectTo="/plans" />
      </div>
    </main>
  )
}
