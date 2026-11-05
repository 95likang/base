import { Skeleton } from '@/components/ui/skeleton'

/** /plans/[id] 骨架：返回行 + sticky 本次训练条 + 封面卡 + 折叠阶段 */
export default function PlanDetailLoading() {
  return (
    <main className="flex flex-col gap-4 p-4" aria-busy="true">
      <p role="status" aria-live="polite" className="sr-only">
        正在加载计划详情…
      </p>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="flex items-center justify-between pt-2">
          <Skeleton className="h-10 w-20 rounded-full" />
          <Skeleton className="h-4 w-16 rounded-sm" />
        </div>

        <div className="-mx-4 border-y-2 border-foreground bg-card px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3 w-16 rounded-sm" />
              <Skeleton className="mt-1.5 h-5 w-2/3 rounded-sm" />
            </div>
            <Skeleton className="h-11 w-20 shrink-0 rounded-full" />
          </div>
        </div>

        <div className="rounded-xl border-2 border-border bg-card p-4 shadow-card">
          <Skeleton className="h-3 w-20 rounded-sm" />
          <Skeleton className="mt-2 h-6 w-3/4 rounded-sm" />
          <Skeleton className="mt-2 h-4 w-full rounded-sm" />
          <Skeleton className="mt-1.5 h-4 w-5/6 rounded-sm" />
          <Skeleton className="mt-3 h-3 w-2/3 rounded-sm" />
          <Skeleton className="mt-4 h-3 w-12 rounded-sm" />
          <Skeleton className="mt-2 h-3 w-full rounded-full" />
        </div>

        {['phase-one', 'phase-two'].map((slot) => (
          <div
            key={slot}
            className="flex items-center justify-between rounded-xl border-2 border-border bg-card p-4 shadow-card"
          >
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3 w-16 rounded-sm" />
              <Skeleton className="mt-1.5 h-5 w-1/2 rounded-sm" />
            </div>
            <Skeleton className="ml-2 size-5 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </main>
  )
}
