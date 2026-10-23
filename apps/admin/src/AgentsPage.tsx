import { useQuery } from '@tanstack/react-query'
import { client, readError } from './lib/api'

const STATUS_LABEL: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  error: '失败',
  timeout: '超时',
}

const STATUS_STYLE: Record<string, string> = {
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  timeout: 'bg-yellow-100 text-yellow-700',
}

/**
 * 子 Agent 运行记录：spawn_agent 派生的任务只回传结论，
 * 这里能看到每个子 Agent 的状态、耗时与结果摘要。
 */
export function AgentsPage() {
  const runsQuery = useQuery({
    queryKey: ['agents'],
    // 只在有运行中的记录时轮询，空闲时不打扰后端
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === 'running') ? 3000 : false,
    queryFn: async () => {
      const res = await client.api.agents.$get()
      if (!res.ok) throw new Error(await readError(res))
      return res.json()
    },
  })

  const runs = runsQuery.data?.runs ?? []
  const config = runsQuery.data?.config
  const running = runs.filter((run) => run.status === 'running').length

  return (
    <main className="mx-auto max-w-5xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">子 Agent</h1>
        <span className="text-sm text-gray-500">
          共 {runs.length} 条 · 执行中 {running}
          {config
            ? ` / 并发上限 ${config.maxConcurrent} · 超时 ${config.defaultTimeout / 1000}s`
            : ''}
        </span>
      </div>

      {runsQuery.isPending && <p className="text-gray-500">加载中…</p>}
      {runsQuery.isError && <p className="text-red-600">加载失败。</p>}
      {!runsQuery.isPending && runs.length === 0 && (
        <p className="text-gray-500">还没有子 Agent 运行记录。对话中派生任务后会出现在这里。</p>
      )}

      <ul className="space-y-3">
        {[...runs].reverse().map((run) => (
          <li key={run.id} className="rounded border border-gray-200 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`shrink-0 rounded px-2 py-0.5 text-xs ${STATUS_STYLE[run.status]}`}
                >
                  {STATUS_LABEL[run.status]}
                </span>
                <span className="shrink-0 font-mono text-xs text-gray-500">
                  {run.id} · depth={run.depth}
                </span>
                <span className="truncate font-medium" title={run.task}>
                  {run.task}
                </span>
              </div>
              <span className="shrink-0 text-xs text-gray-500">
                {new Date(run.startedAt).toLocaleString()}
                {run.finishedAt
                  ? ` · ${Math.max(
                      0,
                      Math.round(
                        (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) /
                          1000,
                      ),
                    )}s`
                  : ''}
              </span>
            </div>
            {(run.result || run.error) && (
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-100 p-2 font-mono text-xs">
                {run.error ?? run.result}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </main>
  )
}
