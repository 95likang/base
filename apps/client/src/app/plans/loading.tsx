import { Skeleton } from '@/components/ui/skeleton'

/** /plans 列表骨架：镜像标题行 + 贴纸卡的六段结构 */
export default function PlansLoading() {
  return (
    <main className="flex flex-col gap-4 p-4" aria-busy="true">
      <p role="status" aria-live="polite" className="sr-only">
        正在加载计划…
      </p>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="flex items-end justify-between pt-2">
          <Skeleton className="h-8 w-32 rounded-sm" />
          <Skeleton className="h-10 w-24 rounded-full" />
        </div>

        {['first-card', 'second-card'].map((slot) => (
          <div key={slot} className="rounded-xl border-2 border-border bg-card p-4 shadow-card">
            <div className="flex items-start justify-between gap-2">
              <Skeleton className="h-5 w-2/3 rounded-sm" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="mt-2 h-4 w-full rounded-sm" />
            <Skeleton className="mt-1.5 h-4 w-4/5 rounded-sm" />

            <div className="mt-3 rounded-xl border-2 border-border p-3">
              <Skeleton className="h-3 w-14 rounded-sm" />
              <Skeleton className="mt-2 h-5 w-1/2 rounded-sm" />
              <Skeleton className="mt-2 h-4 w-full rounded-sm" />
              <Skeleton className="mt-3 h-12 w-full rounded-full" />
            </div>

            <div className="mt-4 flex items-center justify-between">
              <Skeleton className="h-3 w-16 rounded-sm" />
              <Skeleton className="h-3 w-12 rounded-sm" />
            </div>
            <Skeleton className="mt-2 h-2.5 w-full rounded-full" />
          </div>
        ))}
      </div>
    </main>
  )
}
