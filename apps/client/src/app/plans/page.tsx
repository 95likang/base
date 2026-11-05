import { parseRoadmapContent } from 'api/roadmap/spec'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { createServerClient } from '@/lib/api'
import { relativeDay } from '@/lib/date'
import { DeletePlanButton } from './DeletePlanButton'

export const dynamic = 'force-dynamic'

/**
 * 「我的计划」列表：全部路线图，最近更新的在前。
 * 内容存在 JSONB 里，渲染前统一用 parseRoadmapContent 重建；
 * 内容损坏或 currentPhaseIndex 越界的记录直接跳过，不渲染半张卡。
 * 每张卡回答三件事：这是哪个阶段、下一次练什么、整体完成了多少。
 */
export default async function PlansPage() {
  const client = createServerClient()
  const res = await client.api.roadmaps.$get()

  if (!res.ok) {
    return (
      <main className="flex flex-col gap-4 p-4">
        <h1 className="pt-2 text-2xl">我的计划</h1>
        <p className="rounded-xl border-2 border-destructive bg-card px-4 py-3 text-sm leading-relaxed text-destructive">
          加载计划失败，请稍后重试。如果一直失败，可以回到对话页重新生成计划。
        </p>
        <Button asChild variant="outline" className="self-start">
          <a href="/plans">重新加载</a>
        </Button>
      </main>
    )
  }

  const { roadmaps } = await res.json()
  const items = roadmaps.flatMap((row) => {
    const content = parseRoadmapContent(row.content)
    if (!content) return []
    const sessions = content.phases.flatMap((phase, phaseIndex) =>
      phase.sessions.map((session, sessionIndex) => ({
        session,
        phaseIndex,
        sessionIndex,
      })),
    )
    return [
      {
        id: row.id,
        content,
        done: sessions.filter(({ session }) => session.status === 'done').length,
        total: sessions.length,
        next: sessions.find(({ session }) => session.status !== 'done') ?? null,
      },
    ]
  })

  const hidden = roadmaps.length - items.length

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex items-end justify-between pt-2">
        <h1 className="text-2xl">我的计划</h1>
        {items.length > 0 ? (
          <Button asChild size="sm">
            <Link href="/chat">去聊计划</Link>
          </Button>
        ) : null}
      </header>

      {hidden > 0 ? (
        <p
          role="status"
          className="rounded-xl border-2 border-tertiary bg-card px-4 py-3 text-sm leading-relaxed"
        >
          有 {hidden} 份计划数据不完整，已隐藏。可以回到来源会话让教练重新生成。
        </p>
      ) : null}

      {items.length === 0 ? (
        <Card className="items-center gap-3 border-dashed py-10 text-center shadow-none hover:scale-100 hover:rotate-0 hover:shadow-none">
          <CardTitle>还没有训练计划</CardTitle>
          <CardDescription>去对话里让教练帮你排一个。</CardDescription>
          <CardContent className="flex flex-row">
            <Button asChild size="sm">
              <Link href="/chat">开始对话</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map(({ id, content, done, total, next }) => {
            const meta = [
              content.startDate && content.endDate
                ? `${content.startDate} 至 ${content.endDate}`
                : null,
              content.overallDuration ? `总周期 ${content.overallDuration}` : null,
              content.sessionsPerWeek ? `每周 ${content.sessionsPerWeek} 次` : null,
              content.sessionMinutes ? `每次 ${content.sessionMinutes} 分钟` : null,
            ].filter((text): text is string => Boolean(text))
            const percent = Math.round((done / total) * 100)
            const rel = next ? relativeDay(next.session.date) : null

            return (
              <li key={id}>
                <Card className="hover:rotate-0 hover:scale-100 hover:shadow-card">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="min-w-0 text-base leading-snug">
                        <h2 className="min-w-0 leading-snug">
                          <Link
                            href={`/plans/${id}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {content.title}
                          </Link>
                        </h2>
                      </CardTitle>
                      <span className="shrink-0 rounded-full border-2 border-foreground bg-tertiary px-2 py-0.5 text-xs font-bold">
                        阶段 {content.currentPhaseIndex + 1}/{content.phases.length}
                      </span>
                    </div>
                    <CardDescription className="line-clamp-2">
                      {content.summary || '暂无简介'}
                    </CardDescription>
                  </CardHeader>

                  <CardContent>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {meta.join(' · ')}
                    </p>
                  </CardContent>

                  <CardContent className="flex flex-col gap-4">
                    <div className="rounded-xl border-2 border-foreground bg-muted/40 p-3">
                      <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
                        下一次
                      </p>
                      {next ? (
                        <>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <p className="font-heading text-base font-extrabold tabular-nums">
                              {next.session.date ? `${next.session.date} ` : ''}
                              {next.session.startTime && next.session.endTime
                                ? `${next.session.startTime}–${next.session.endTime}`
                                : null}
                            </p>
                            {rel ? (
                              <span
                                className={
                                  rel.overdue
                                    ? 'rounded-full border-2 border-destructive px-1.5 py-0.5 text-xs font-bold text-destructive'
                                    : 'rounded-full border-2 border-foreground bg-quaternary px-1.5 py-0.5 text-xs font-bold'
                                }
                              >
                                {rel.label}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 line-clamp-2 text-sm leading-relaxed">
                            {next.session.task}
                          </p>
                          <Button asChild className="mt-2 w-full">
                            <Link
                              href={`/plans/${id}?phase=${next.phaseIndex}#session-${next.phaseIndex}-${next.sessionIndex}`}
                            >
                              查看这次
                            </Link>
                          </Button>
                        </>
                      ) : (
                        <p className="mt-1 text-sm leading-relaxed font-bold">全部训练已完成。</p>
                      )}
                    </div>

                    <div>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
                          已完成
                        </span>
                        <span className="font-heading text-sm font-extrabold tabular-nums">
                          {done} / {total}
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={`${content.title} 完成进度`}
                        aria-valuemin={0}
                        aria-valuemax={total}
                        aria-valuenow={done}
                        className="mt-1.5 h-2.5 overflow-hidden rounded-full border-2 border-foreground bg-muted"
                      >
                        <div className="h-full bg-quaternary" style={{ width: `${percent}%` }} />
                      </div>
                    </div>
                  </CardContent>

                  <CardFooter className="justify-between border-t pt-3">
                    <Link
                      href={`/plans/${id}`}
                      className="text-sm font-bold text-accent underline-offset-4 hover:underline"
                    >
                      查看详情 →
                    </Link>
                    <DeletePlanButton id={id} />
                  </CardFooter>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
