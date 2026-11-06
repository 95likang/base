'use client'

import { Eye, EyeOff } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authClient } from '@/lib/auth-client'

/**
 * 登录后的目标页：只接受同源路径，避免 redirect 参数被用作开放重定向。
 * 用 URL 解析而不是字符串前缀判断：`//host`、`/\host` 这类写法会被浏览器
 * 规范化成站外地址，只有 origin 一致才安全。
 * 仅在浏览器端调用（useEffect / 事件回调）。
 */
function resolveRedirect(): string {
  const redirect = new URLSearchParams(window.location.search).get('redirect')
  if (!redirect) return '/plans'
  const target = new URL(redirect, window.location.origin)
  return target.origin === window.location.origin
    ? `${target.pathname}${target.search}${target.hash}`
    : '/plans'
}

/** 登录/注册页：走同源 rewrite 代理，成功后回到被拦截前想访问的页面。 */
export default function LoginPage() {
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  // 已有有效 session 时不停留在登录页（middleware 只查 cookie 存在性，
  // 页面这里用真实 session 兜底，同时也让失效 cookie 的用户能正常重新登录）
  useEffect(() => {
    if (!isPending && session) {
      router.replace(resolveRedirect())
    }
  }, [isPending, session, router])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setPending(true)
    try {
      const res =
        mode === 'signup'
          ? await authClient.signUp.email({ name, email, password })
          : await authClient.signIn.email({ email, password })
      if (res.error) {
        setError(res.error.message ?? '认证失败，请重试。')
        return
      }
      router.push(resolveRedirect())
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-6">
      <header className="pt-6 text-center">
        <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          Practice Coach
        </p>
        <h1 className="text-3xl">{mode === 'signup' ? '创建账号' : '登录'}</h1>
      </header>

      <Card className="hover:rotate-0 hover:scale-100 hover:shadow-card">
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {mode === 'signup' && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">昵称</Label>
                <Input
                  id="name"
                  placeholder="你的昵称"
                  autoComplete="nickname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password">密码</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="至少 8 位"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="pr-12"
                />
                <button
                  type="button"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-muted-foreground"
                >
                  {showPassword ? (
                    <EyeOff className="size-5" strokeWidth={2.5} />
                  ) : (
                    <Eye className="size-5" strokeWidth={2.5} />
                  )}
                </button>
              </div>
            </div>

            <Button type="submit" disabled={pending} className="w-full">
              {pending ? '请稍候…' : mode === 'signup' ? '注册' : '登录'}
            </Button>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </form>
        </CardContent>
      </Card>

      <p className="text-center text-sm text-muted-foreground">
        {mode === 'signup' ? '已有账号？' : '还没有账号？'}
        <button
          type="button"
          className="ml-1 font-bold text-accent underline-offset-4 hover:underline"
          onClick={() => {
            setMode(mode === 'signup' ? 'signin' : 'signup')
            setError('')
          }}
        >
          {mode === 'signup' ? '去登录' : '去注册'}
        </button>
      </p>
    </main>
  )
}
