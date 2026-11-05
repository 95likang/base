'use client'

import { LogIn, LogOut } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { authClient } from '@/lib/auth-client'

/** 「我的」：账号信息与登录/退出入口。 */
export default function MePage() {
  const { data: session, isPending } = authClient.useSession()

  const signOut = async () => {
    await authClient.signOut()
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Account</p>
        <h1 className="text-2xl">我的</h1>
      </header>

      <Card className="hover:rotate-0 hover:scale-100 hover:shadow-card">
        <CardHeader>
          {isPending ? (
            <CardTitle>加载中…</CardTitle>
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
