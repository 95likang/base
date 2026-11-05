import { Skeleton } from '@/components/ui/skeleton'

/** /chat 列表骨架：标题行 + 与真实行卡等高的三条 */
export default function ChatListLoading() {
  return (
    <main className="flex flex-col gap-4 p-4" aria-busy="true">
      <p role="status" aria-live="polite" className="sr-only">
        正在加载对话…
      </p>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="flex items-end justify-between pt-2">
          <Skeleton className="h-8 w-16 rounded-sm" />
          <Skeleton className="h-10 w-24 rounded-full" />
        </div>

        <div className="flex flex-col gap-3">
          {['chat-one', 'chat-two', 'chat-three'].map((slot) => (
            <div
              key={slot}
              className="flex items-center gap-2 rounded-xl border-2 border-border bg-card px-4 py-3 shadow-card"
            >
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-2/3 rounded-sm" />
                <Skeleton className="mt-1.5 h-3 w-1/3 rounded-sm" />
              </div>
              <Skeleton className="size-11 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
