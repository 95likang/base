'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

/** 路由级错误边界：捕获页面渲染异常，不暴露技术错误，只给可执行的下一步 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  // 线上排障只靠这句日志定位（页面不展示 digest）
  useEffect(() => {
    console.error('[route] 页面渲染失败:', error.digest ?? error.message, error)
  }, [error])

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl">页面没能加载</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        数据暂时取不到，可能是网络或服务端出了问题。可以重试一次，或先回到计划列表。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={reset}>重试</Button>
        <Button asChild variant="outline">
          <a href="/plans">返回计划</a>
        </Button>
      </div>
    </main>
  )
}
