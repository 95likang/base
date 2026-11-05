import { parseRoadmapContent } from 'api/roadmap/spec'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Button } from '@/components/ui/button'
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
    <main className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2 pt-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/plans">
            <ArrowLeft />
            计划
          </Link>
        </Button>
        <div className="flex items-center gap-3">
          <Link
            href={`/chat/${roadmap.chatId}`}
            className="text-xs font-bold text-muted-foreground underline-offset-4 hover:underline"
          >
            来源会话
          </Link>
          <DeletePlanButton id={roadmap.id} redirectTo="/plans" />
        </div>
      </header>

      {content ? (
        <RoadmapCard content={content} roadmapId={roadmap.id} />
      ) : (
        <p className="rounded-xl border-2 border-tertiary bg-card px-4 py-3 text-sm">
          计划数据不完整，无法展示。
        </p>
      )}
    </main>
  )
}
