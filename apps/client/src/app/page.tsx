import { serverClient } from '@/lib/api'

// Always fetch fresh on each request for this demo.
export const dynamic = 'force-dynamic'

/**
 * Next.js 15 Server Component consuming the same `hc<AppType>` RPC instance on
 * the server. The call is awaited during SSR, so the browser never sees the API
 * origin and the response is fully typed from the Hono route definition.
 */
export default async function HomePage() {
  const res = await serverClient.api.users.$get({ query: { limit: '10' } })

  if (!res.ok) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="mb-6 text-2xl font-bold">Users (SSR)</h1>
        <p className="text-red-500">Failed to fetch users from API.</p>
      </main>
    )
  }

  const { users } = await res.json()

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-6 text-2xl font-bold">Users (SSR)</h1>
      <ul className="flex flex-col gap-2">
        {users.map((user) => (
          <li key={user.id} className="rounded border border-gray-200 px-3 py-2">
            <span className="font-medium">{user.name}</span>{' '}
            <span className="text-gray-500">{user.email}</span>
          </li>
        ))}
      </ul>
      {users.length === 0 && <p className="text-gray-500">No users yet.</p>}
    </main>
  )
}
