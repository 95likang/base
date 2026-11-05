'use client'

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
  const [mode, setMode] = useState<'signin' | 'signup'>('signup')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
    <main className="flex flex-col gap-6 p-6">
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                placeholder="至少 8 位"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
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
