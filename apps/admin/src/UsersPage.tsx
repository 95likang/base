import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { client } from './lib/api'

/**
 * Sample page showing the end-to-end type-safe flow:
 *  - `client.api.users.$get()` is fully autocompleted and its response is typed
 *    straight from the Hono route return value.
 *  - The query param `search` is compiler-checked against the Zod schema.
 */
export function UsersPage() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await client.api.users.$get({ query: {} })
      if (!res.ok) throw new Error('Failed to load users')
      // `data.users` is typed as the Drizzle row shape, no manual typing needed.
      const data = await res.json()
      return data.users
    },
  })

  const createUser = useMutation({
    mutationFn: async (input: { name: string; email: string }) => {
      const res = await client.api.users.$post({ json: input })
      if (!res.ok) throw new Error('Failed to create user')
      return res.json()
    },
    onSuccess: () => {
      setName('')
      setEmail('')
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    createUser.mutate({ name, email })
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-6 text-2xl font-bold">Users</h1>

      <form onSubmit={onSubmit} className="mb-8 flex flex-col gap-3">
        <input
          className="rounded border border-gray-300 px-3 py-2"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          className="rounded border border-gray-300 px-3 py-2"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <button
          type="submit"
          disabled={createUser.isPending}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {createUser.isPending ? 'Adding…' : 'Add user'}
        </button>
      </form>

      {usersQuery.isPending && <p>Loading…</p>}
      {usersQuery.isError && <p className="text-red-600">Something went wrong.</p>}

      <ul className="flex flex-col gap-2">
        {usersQuery.data?.map((user) => (
          <li key={user.id} className="rounded border border-gray-200 px-3 py-2">
            <span className="font-medium">{user.name}</span>{' '}
            <span className="text-gray-500">{user.email}</span>
          </li>
        ))}
      </ul>
    </main>
  )
}
