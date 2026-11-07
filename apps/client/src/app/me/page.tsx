'use client'

import { CheckCircle2, ChevronRight, ClipboardList, LogIn, LogOut } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { authClient } from '@/lib/auth-client'
import { ApiError, apiFetch } from '@/lib/http'

type PracticeStats = { plans: number; done: number; total: number }

/** 「我的」：训练统计 + 账号信息与登录/退出入口。 */
export default function MePage() {
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()
  const [stats, setStats] = useState<PracticeStats | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)

  // 只取聚合数字，不把全部计划内容拉到浏览器
  useEffect(() => {
    let cancelled = false
    apiFetch<PracticeStats>('/api/roadmaps/stats')
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch((err) => {
        // 401 已在 apiFetch 内跳转登录
        if (cancelled || (err instanceof ApiError && err.status === 401)) return
        setStatsFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const signOut = async () => {
    await authClient.signOut()
    // 退出后 cookie 已失效，直接回登录页，避免停留在 401 的错误态
    router.replace('/login')
    router.refresh()
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl">我的</h1>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <Link href="/plans" className="block rounded-xl">
          <Card className="h-full gap-2 py-4 hover:rotate-0 hover:scale-100 hover:shadow-card">
            <CardContent className="flex flex-row items-center gap-2">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-foreground bg-tertiary">
                <ClipboardList className="size-5" strokeWidth={2.5} />
              </span>
              <div>
                {stats ? (
                  <p className="font-heading text-xl font-extrabold tabular-nums">{stats.plans}</p>
                ) : statsFailed ? (
                  <p className="font-heading text-xl font-extrabold">—</p>
                ) : (
                  <Skeleton className="h-7 w-12 rounded-sm" />
                )}
                <p className="text-xs text-muted-foreground">训练计划</p>
              </div>
              <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
            </CardContent>
          </Card>
        </Link>

        <Card className="gap-2 py-4 hover:rotate-0 hover:scale-100 hover:shadow-card">
          <CardContent className="flex flex-row items-center gap-2">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-foreground bg-quaternary">
              <CheckCircle2 className="size-5" strokeWidth={2.5} />
            </span>
            <div>
              {stats ? (
                <p className="font-heading text-xl font-extrabold tabular-nums">
                  {stats.done}/{stats.total}
                </p>
              ) : statsFailed ? (
                <p className="font-heading text-xl font-extrabold">—</p>
              ) : (
                <Skeleton className="h-7 w-16 rounded-sm" />
              )}
              <p className="text-xs text-muted-foreground">已完成的训练</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {statsFailed ? (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          统计暂时取不到，
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="font-bold text-accent underline underline-offset-2"
          >
            重新加载
          </button>
        </p>
      ) : null}

      <Card className="hover:rotate-0 hover:scale-100 hover:shadow-card">
        <CardHeader>
          {isPending ? (
            <div className="flex items-center gap-3">
              <Skeleton className="size-14 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-5 w-1/2 rounded-sm" />
                <Skeleton className="mt-1.5 h-3 w-2/3 rounded-sm" />
              </div>
            </div>
          ) : session ? (
            <div className="flex items-center gap-3">
              <span className="flex size-14 shrink-0 items-center justify-center rounded-full border-2 border-foreground bg-secondary font-heading text-xl font-extrabold text-secondary-foreground shadow-pop-sm">
                {(session.user.name || session.user.email).slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <CardTitle className="truncate text-lg">{session.user.name}</CardTitle>
                <CardDescription className="truncate">{session.user.email}</CardDescription>
              </div>
            </div>
          ) : (
            <>
              <CardTitle>未登录</CardTitle>
              <CardDescription>登录后可同步训练计划与对话记录。</CardDescription>
            </>
          )}
        </CardHeader>

        {!isPending && (
          <CardContent>
            {session ? (
              <Button variant="secondary" className="w-full" onClick={signOut}>
                <LogOut />
                退出登录
              </Button>
            ) : (
              <Button asChild className="w-full">
                <Link href="/login">
                  <LogIn />
                  去登录
                </Link>
              </Button>
            )}
          </CardContent>
        )}
      </Card>
    </main>
  )
}
