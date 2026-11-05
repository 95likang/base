import { Skeleton } from '@/components/ui/skeleton'

/** /me 骨架：标题 + 双统计卡 + 账号卡 */
export default function MeLoading() {
  return (
    <main className="flex flex-col gap-4 p-4" aria-busy="true">
      <p role="status" aria-live="polite" className="sr-only">
        正在加载我的…
      </p>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="pt-2">
          <Skeleton className="h-8 w-16 rounded-sm" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          {['plans-stat', 'sessions-stat'].map((slot) => (
            <div key={slot} className="rounded-xl border-2 border-border bg-card p-4 shadow-card">
              <div className="flex items-center gap-2">
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-6 w-12 rounded-sm" />
                  <Skeleton className="mt-1.5 h-3 w-16 rounded-sm" />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-xl border-2 border-border bg-card p-4 shadow-card">
          <div className="flex items-center gap-3">
            <Skeleton className="size-14 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-5 w-1/2 rounded-sm" />
              <Skeleton className="mt-1.5 h-3 w-2/3 rounded-sm" />
            </div>
          </div>
          <Skeleton className="mt-4 h-12 w-full rounded-full" />
        </div>
      </div>
    </main>
  )
}
