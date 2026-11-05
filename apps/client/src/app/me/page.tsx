'use client'

import { parseRoadmapContent } from 'api/roadmap/spec'
import { CheckCircle2, ClipboardList, LogIn, LogOut } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { authClient } from '@/lib/auth-client'

type PracticeStats = { plans: number; done: number; total: number }

/** 「我的」：训练统计 + 账号信息与登录/退出入口。 */
export default function MePage() {
  const { data: session, isPending } = authClient.useSession()
  const [stats, setStats] = useState<PracticeStats | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/roadmaps')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return
        if (!data) {
          setStatsFailed(true)
          return
        }
        const rows = (data.roadmaps ?? []) as Array<{ content: unknown }>
        const contents = rows.flatMap((row) => {
          const content = parseRoadmapContent(row.content)
          return content ? [content] : []
        })
        const sessions = contents.flatMap((content) => content.phases.flatMap((p) => p.sessions))
        setStats({
          plans: contents.length,
          done: sessions.filter((session) => session.status === 'done').length,
          total: sessions.length,
        })
      })
      .catch(() => {
        if (!cancelled) setStatsFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const signOut = async () => {
    await authClient.signOut()
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl">我的</h1>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <Card className="gap-2 py-4 hover:rotate-0 hover:scale-100 hover:shadow-card">
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
          </CardContent>
        </Card>

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
