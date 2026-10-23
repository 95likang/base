import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthForm } from './AuthForm'
import { authClient } from './lib/auth-client'
import { PluginsPage } from './PluginsPage'
import { RagPage } from './RagPage'
import { SkillsPage } from './SkillsPage'
import { UsersPage } from './UsersPage'
import './index.css'

const queryClient = new QueryClient()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')

/** 会话门控：未登录显示 AuthForm，登录后显示业务页面。 */
function App() {
  const { data: session, isPending } = authClient.useSession()
  const [tab, setTab] = useState<'users' | 'rag' | 'skills' | 'plugins'>('users')

  if (isPending) {
    return <p className="mx-auto max-w-xl p-8 text-gray-500">Loading…</p>
  }

  if (!session) {
    return <AuthForm />
  }

  return (
    <>
      <header className="flex items-center justify-between border-b border-gray-200 px-8 py-3">
        <nav className="flex gap-1 text-sm">
          <TabButton active={tab === 'users'} onClick={() => setTab('users')}>
            Users
          </TabButton>
          <TabButton active={tab === 'rag'} onClick={() => setTab('rag')}>
            知识库
          </TabButton>
          <TabButton active={tab === 'skills'} onClick={() => setTab('skills')}>
            Skills
          </TabButton>
          <TabButton active={tab === 'plugins'} onClick={() => setTab('plugins')}>
            Plugins
          </TabButton>
        </nav>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">
            Signed in as <span className="font-medium">{session.user.email}</span>
          </span>
          <button type="button" className="text-sm underline" onClick={() => authClient.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      {tab === 'users' ? (
        <UsersPage />
      ) : tab === 'rag' ? (
        <RagPage />
      ) : tab === 'skills' ? (
        <SkillsPage />
      ) : (
        <PluginsPage />
      )}
    </>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1.5 ${active ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-100'}`}
    >
      {children}
    </button>
  )
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
