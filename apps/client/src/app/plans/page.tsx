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
import { DeletePlanButton } from './DeletePlanButton'

export const dynamic = 'force-dynamic'

const META_COLORS = ['bg-tertiary', 'bg-quaternary', 'bg-secondary'] as const

/**
 * 「我的计划」列表：全部路线图，最近创建的在前。
 * 内容存在 JSONB 里，渲染前统一用 parseRoadmapContent 重建；
 * 内容损坏或 currentPhaseIndex 越界的记录直接跳过，不渲染半张卡。
 */
export default async function PlansPage() {
  const client = createServerClient()
  const res = await client.api.roadmaps.$get()

  if (!res.ok) {
    return (
      <main className="flex flex-col gap-4 p-4">
        <h1 className="pt-2 text-2xl">我的计划</h1>
        <p className="rounded-xl border-2 border-destructive bg-card px-4 py-3 text-sm text-destructive">
          加载计划失败（{res.status}），请稍后重试。
        </p>
      </main>
    )
  }

  const { roadmaps } = await res.json()
  const items = roadmaps.flatMap((row) => {
    const content = parseRoadmapContent(row.content)
    return content ? [{ id: row.id, createdAt: row.createdAt, content }] : []
  })

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex items-end justify-between pt-2">
        <div>
          <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
            Practice Coach
          </p>
          <h1 className="text-2xl">我的计划</h1>
        </div>
        <Button asChild size="sm">
          <Link href="/chat">去聊计划</Link>
        </Button>
      </header>

      {items.length === 0 ? (
        <Card className="items-center gap-3 border-dashed py-10 text-center shadow-none hover:scale-100 hover:rotate-0 hover:shadow-none">
          <CardTitle>还没有训练计划</CardTitle>
          <CardDescription>去对话里让教练帮你排一个。</CardDescription>
          <CardContent>
            <Button asChild size="sm">
              <Link href="/chat">开始对话</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map(({ id, createdAt, content }, index) => {
            const meta = [
              content.startDate && content.endDate
                ? `${content.startDate} 至 ${content.endDate}`
                : null,
              content.overallDuration ? `总周期 ${content.overallDuration}` : null,
              content.sessionsPerWeek ? `每周 ${content.sessionsPerWeek} 次` : null,
              content.sessionMinutes ? `每次 ${content.sessionMinutes} 分钟` : null,
              `${content.phases.length} 个阶段`,
            ].filter((text): text is string => Boolean(text))

            return (
              <li key={id}>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      <Link href={`/plans/${id}`}>{content.title}</Link>
                    </CardTitle>
                    <CardDescription className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{content.summary || '暂无简介'}</span>
                      <span className="shrink-0 text-xs">
                        {new Date(createdAt).toLocaleDateString('zh-CN')}
                      </span>
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="flex flex-wrap gap-1.5">
                    {meta.map((text, i) => (
                      <span
                        key={text}
                        className={`rounded-full border-2 border-foreground px-2 py-0.5 text-[11px] font-bold text-foreground ${META_COLORS[(index + i) % META_COLORS.length]}`}
                      >
                        {text}
                      </span>
                    ))}
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
