import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthForm } from './AuthForm'
import { authClient } from './lib/auth-client'
import { UsersPage } from './UsersPage'
import './index.css'

const queryClient = new QueryClient()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

/** 会话门控：未登录显示 AuthForm，登录后显示业务页面。 */
function App() {
  const { data: session, isPending } = authClient.useSession()

  if (isPending) {
    return <p className="mx-auto max-w-xl p-8 text-gray-500">Loading…</p>
  }

  if (!session) {
    return <AuthForm />
  }

  return (
    <>
      <header className="flex items-center justify-between border-b border-gray-200 px-8 py-3">
        <span className="text-sm text-gray-600">
          Signed in as <span className="font-medium">{session.user.email}</span>
        </span>
        <button type="button" className="text-sm underline" onClick={() => authClient.signOut()}>
          Sign out
        </button>
      </header>
      <UsersPage />
    </>
  )
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
