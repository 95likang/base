import { parseRoadmapContent } from 'api/roadmap/spec'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/api'
import { RoadmapCard } from '@/roadmap/RoadmapPart'
import { DeletePlanButton } from '../DeletePlanButton'

export const dynamic = 'force-dynamic'

/** 计划详情：完整两级路线图 + 返回列表 + 来源会话 */
export default async function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const client = createServerClient()
  const res = await client.api.roadmaps[':id'].$get({ param: { id } })

  if (!res.ok) notFound()

  const { roadmap } = await res.json()
  const content = parseRoadmapContent(roadmap.content)

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/plans" className="text-sm text-gray-500 underline">
          ← 返回我的计划
        </Link>
        <div className="flex items-center gap-3">
          <Link href={`/chat?id=${roadmap.chatId}`} className="text-sm text-gray-500 underline">
            来源会话
          </Link>
          <DeletePlanButton id={roadmap.id} redirectTo="/plans" />
        </div>
      </div>

      {content ? (
        <RoadmapCard content={content} roadmapId={roadmap.id} />
      ) : (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          计划数据不完整，无法展示。
        </p>
      )}
    </main>
  )
}
