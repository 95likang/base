import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { client, readError } from './lib/api'

const SECURITY_KEY = ['security']

/** 角色说明：与后端 roles.ts 的 TOOL_ACCESS 保持一致 */
const ROLE_INFO: Record<string, string> = {
  owner: '全部工具，包括 bash',
  collaborator: '除 bash 外的全部工具',
  guest: '只读工具：天气、计算器、读文件、列目录、glob、grep、知识库检索',
}

/**
 * 执行权限管理页：查看/切换进程级角色，查看已注册的 Hook。
 * 角色只影响切换之后新建的请求级 registry，进行中的请求不受影响。
 */
export function SecurityPage() {
  const queryClient = useQueryClient()

  const statusQuery = useQuery({
    queryKey: SECURITY_KEY,
    queryFn: async () => {
      const res = await client.api.security.$get()
      if (!res.ok) throw new Error(await readError(res))
      return res.json()
    },
  })

  const switchRole = useMutation({
    mutationFn: async (role: 'owner' | 'collaborator' | 'guest') => {
      const res = await client.api.security.role.$patch({ json: { role } })
      if (!res.ok) throw new Error(await readError(res))
      return res.json()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SECURITY_KEY }),
  })

  const status = statusQuery.data

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-2xl font-bold">执行权限</h1>

      {statusQuery.isPending && <p className="text-gray-500">加载中…</p>}
      {statusQuery.isError && <p className="text-red-600">{statusQuery.error.message}</p>}

      {status && (
        <>
          <section className="mb-8">
            <h2 className="mb-2 text-lg font-semibold">当前角色</h2>
            <p className="mb-3 text-sm text-gray-500">
              角色决定模型能看到哪些工具；bash 即使对 owner 也会再做危险命令检测。
              切换是进程级操作，只有 ADMIN_EMAILS 白名单内的账号可以执行。
            </p>
            <div className="flex flex-col gap-2">
              {status.roles.map((role) => (
                <label
                  key={role}
                  className="flex cursor-pointer items-start gap-3 rounded border border-gray-200 px-3 py-2"
                >
                  <input
                    type="radio"
                    name="role"
                    className="mt-1"
                    checked={status.role === role}
                    disabled={switchRole.isPending}
                    onChange={() => switchRole.mutate(role)}
                  />
                  <span>
                    <span className="font-medium">{role}</span>
                    <span className="ml-2 text-sm text-gray-500">{ROLE_INFO[role]}</span>
                  </span>
                </label>
              ))}
            </div>
            {switchRole.isError && (
              <p className="mt-2 text-sm text-red-600">{switchRole.error.message}</p>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold">Hook 管线</h2>
            {status.hooks.pre.length === 0 && status.hooks.post.length === 0 ? (
              <p className="text-sm text-gray-500">没有注册的 Hook。</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-600">
                    <th className="py-2 pr-3">阶段</th>
                    <th className="py-2 pr-3">名称</th>
                  </tr>
                </thead>
                <tbody>
                  {status.hooks.pre.map((name) => (
                    <tr key={`pre-${name}`} className="border-b border-gray-100">
                      <td className="py-2 pr-3 text-gray-600">Pre-Tool</td>
                      <td className="py-2 pr-3 font-mono">{name}</td>
                    </tr>
                  ))}
                  {status.hooks.post.map((name) => (
                    <tr key={`post-${name}`} className="border-b border-gray-100">
                      <td className="py-2 pr-3 text-gray-600">Post-Tool</td>
                      <td className="py-2 pr-3 font-mono">{name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  )
}
