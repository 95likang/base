import { parseRoadmapContent } from 'api/roadmap/spec'
import Link from 'next/link'
import { createServerClient } from '@/lib/api'
import { DeletePlanButton } from './DeletePlanButton'

export const dynamic = 'force-dynamic'

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
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="mb-4 text-xl font-bold">我的计划</h1>
        <p className="text-red-600">加载计划失败（{res.status}），请稍后重试。</p>
      </main>
    )
  }

  const { roadmaps } = await res.json()
  const items = roadmaps.flatMap((row) => {
    const content = parseRoadmapContent(row.content)
    return content ? [{ id: row.id, createdAt: row.createdAt, content }] : []
  })

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">我的计划</h1>
        <Link href="/chat" className="text-sm text-gray-500 underline">
          返回聊天
        </Link>
      </div>

      {items.length === 0 ? (
        <p className="text-gray-500">
          还没有训练计划。
          <Link href="/chat" className="underline">
            去聊天里让 practice-coach 帮你排一个
          </Link>
          。
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map(({ id, createdAt, content }) => (
            <li key={id} className="flex items-start gap-2">
              <Link
                href={`/plans/${id}`}
                className="block min-w-0 flex-1 rounded-lg border bg-white p-4 hover:bg-gray-50"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{content.title}</span>
                  <span className="shrink-0 text-xs text-gray-500">
                    {new Date(createdAt).toLocaleDateString('zh-CN')}
                  </span>
                </div>
                {content.summary ? (
                  <p className="mt-1 text-sm text-gray-600">{content.summary}</p>
                ) : null}
                <p className="mt-2 text-xs text-gray-500">
                  {content.startDate && content.endDate
                    ? `${content.startDate} 至 ${content.endDate} · `
                    : ''}
                  {content.overallDuration ? `总周期 ${content.overallDuration} · ` : ''}
                  {content.sessionsPerWeek ? `每周 ${content.sessionsPerWeek} 次 · ` : ''}
                  {content.sessionMinutes ? `每次 ${content.sessionMinutes} 分钟 · ` : ''}
                  {content.phases.length} 个阶段
                </p>
              </Link>
              <div className="pt-4">
                <DeletePlanButton id={id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
