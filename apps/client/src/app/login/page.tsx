'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { authClient } from '@/lib/auth-client'

/** 登录/注册页：走同源 rewrite 代理，成功后跳回首页（SSR 会带上新 cookie）。 */
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
        setError(res.error.message ?? 'Authentication failed.')
        return
      }
      router.push('/')
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-6 text-2xl font-bold">
        {mode === 'signup' ? 'Create account' : 'Sign in'}
      </h1>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        {mode === 'signup' && (
          <input
            className="rounded border border-gray-300 px-3 py-2"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}
        <input
          className="rounded border border-gray-300 px-3 py-2"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="rounded border border-gray-300 px-3 py-2"
          type="password"
          placeholder="Password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {pending ? 'Please wait…' : mode === 'signup' ? 'Sign up' : 'Sign in'}
        </button>
        {error && <p className="text-red-600">{error}</p>}
      </form>

      <p className="mt-4 text-sm text-gray-500">
        {mode === 'signup' ? 'Already have an account?' : "Don't have an account?"}{' '}
        <button
          type="button"
          className="underline"
          onClick={() => {
            setMode(mode === 'signup' ? 'signin' : 'signup')
            setError('')
          }}
        >
          {mode === 'signup' ? 'Sign in' : 'Sign up'}
        </button>
      </p>
    </main>
  )
}
