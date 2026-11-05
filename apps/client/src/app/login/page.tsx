'use client'

import { Eye, EyeOff } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authClient } from '@/lib/auth-client'

/** 登录/注册页：走同源 rewrite 代理，成功后回到「我的」页。 */
export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

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
      router.push('/me')
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

      <p className="text-center">
        <Link
          href="/plans"
          className="text-sm font-bold text-muted-foreground underline-offset-4 hover:underline"
        >
          先逛逛，稍后登录
        </Link>
      </p>
    </main>
  )
}
