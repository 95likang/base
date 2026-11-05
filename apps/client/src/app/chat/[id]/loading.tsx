import { Skeleton } from '@/components/ui/skeleton'

/** /chat/[id] 骨架：header + 消息气泡 + 底部输入条 */
export default function ChatDetailLoading() {
  return (
    <main className="flex h-full flex-col bg-background" aria-busy="true">
      <p role="status" aria-live="polite" className="sr-only">
        正在加载对话…
      </p>
      <header className="flex shrink-0 items-center gap-2 border-b-2 border-foreground bg-card px-3 py-2">
        <Skeleton className="h-11 w-20 rounded-full" />
        <Skeleton className="h-4 w-32 rounded-sm" />
      </header>

      <div aria-hidden="true" className="flex flex-1 flex-col gap-3 px-4 py-4">
        <Skeleton className="h-16 w-4/5 rounded-2xl" />
        <Skeleton className="ml-auto h-20 w-3/4 rounded-2xl" />
        <Skeleton className="h-28 w-4/5 rounded-2xl" />
      </div>

      <div className="shrink-0 border-t-2 border-foreground bg-card px-3 py-2">
        <Skeleton className="h-12 w-full rounded-md" />
      </div>
    </main>
  )
}
