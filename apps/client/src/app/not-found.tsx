import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl">页面不存在</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        这个计划或会话可能已被删除，链接也可能过时了。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/plans">返回计划</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/chat">去对话</Link>
        </Button>
      </div>
    </main>
  )
}
