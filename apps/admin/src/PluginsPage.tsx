import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { client, readError } from './lib/api'

const PLUGINS_KEY = ['plugins']

/**
 * 插件管理页：查看可加载插件与已注册工具，运行期加载/卸载。
 * 加载状态只在当前进程内有效，API 重启后回到启动时的自动加载状态。
 */
export function PluginsPage() {
  const queryClient = useQueryClient()

  const pluginsQuery = useQuery({
    queryKey: PLUGINS_KEY,
    queryFn: async () => {
      const res = await client.api.plugins.$get()
      if (!res.ok) throw new Error(await readError(res))
      const data = await res.json()
      return data.plugins
    },
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: PLUGINS_KEY })

  const load = useMutation({
    mutationFn: async (name: string) => {
      const res = await client.api.plugins[':name'].load.$post({ param: { name } })
      if (!res.ok) throw new Error(await readError(res))
    },
    onSuccess: refresh,
  })

  const unload = useMutation({
    mutationFn: async (name: string) => {
      const res = await client.api.plugins[':name'].unload.$post({ param: { name } })
      if (!res.ok) throw new Error(await readError(res))
    },
    onSuccess: refresh,
  })

  const plugins = pluginsQuery.data ?? []
  const busy = load.isPending || unload.isPending

  return (
    <main className="mx-auto max-w-4xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Plugins</h1>
        <span className="text-sm text-gray-500">
          共 {plugins.length} 个 · 已加载 {plugins.filter((p) => p.loaded).length} 个
        </span>
      </div>

      <p className="mb-6 text-sm text-gray-500">
        插件在 API 启动时自动加载；此处的加载/卸载只影响当前进程，重启后恢复。
      </p>

      {pluginsQuery.isPending && <p className="text-gray-500">加载中…</p>}
      {pluginsQuery.isError && <p className="text-red-600">加载失败。</p>}
      {!pluginsQuery.isPending && plugins.length === 0 && (
        <p className="text-gray-500">还没有可用的插件。</p>
      )}
      {plugins.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-600">
              <th className="py-2 pr-3">名称</th>
              <th className="py-2 pr-3">版本</th>
              <th className="py-2 pr-3">描述</th>
              <th className="py-2 pr-3">工具</th>
              <th className="py-2 pr-3">状态</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {plugins.map((plugin) => (
              <tr key={plugin.name} className="border-b border-gray-100 align-top">
                <td className="py-2 pr-3 font-medium">{plugin.name}</td>
                <td className="py-2 pr-3 text-gray-600">{plugin.version}</td>
                <td className="py-2 pr-3 text-gray-600">{plugin.description}</td>
                <td className="py-2 pr-3 text-gray-600">
                  {plugin.tools.length > 0 ? plugin.tools.join(', ') : '-'}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      plugin.loaded ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {plugin.loaded ? '已加载' : '未加载'}
                  </span>
                </td>
                <td className="py-2 text-right whitespace-nowrap">
                  {plugin.loaded ? (
                    <button
                      type="button"
                      className="text-red-600 underline disabled:opacity-50"
                      disabled={busy}
                      onClick={() => unload.mutate(plugin.name)}
                    >
                      卸载
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="text-gray-700 underline disabled:opacity-50"
                      disabled={busy}
                      onClick={() => load.mutate(plugin.name)}
                    >
                      加载
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {load.isError && <p className="mt-2 text-sm text-red-600">{load.error.message}</p>}
      {unload.isError && <p className="mt-2 text-sm text-red-600">{unload.error.message}</p>}
    </main>
  )
}
