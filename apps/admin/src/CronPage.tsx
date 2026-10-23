import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { client, readError } from './lib/api'

const JOBS_KEY = ['cron-jobs']
const LOGS_KEY = ['cron-logs']

const STATUS_LABEL: Record<string, string> = {
  running: '执行中',
  scheduled: '已调度',
  disabled: '已禁用',
  idle: '空闲',
}

const STATUS_STYLE: Record<string, string> = {
  running: 'bg-blue-100 text-blue-700',
  scheduled: 'bg-green-100 text-green-700',
  disabled: 'bg-gray-100 text-gray-500',
  idle: 'bg-yellow-100 text-yellow-700',
}

/**
 * Cron 管理页：查看/新建/删除任务，立即执行、启用禁用，以及查看最近执行日志。
 * 任务定义与日志存在后端 PostgreSQL（cron_job / cron_run_log），重启后自动恢复。
 */
export function CronPage() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ id: '', name: '', schedule: 'every 5m', prompt: '' })

  const jobsQuery = useQuery({
    queryKey: JOBS_KEY,
    queryFn: async () => {
      const res = await client.api.cron.$get()
      if (!res.ok) throw new Error(await readError(res))
      const data = await res.json()
      return data.jobs
    },
  })

  const logsQuery = useQuery({
    queryKey: LOGS_KEY,
    queryFn: async () => {
      const res = await client.api.cron.logs.$get({ query: { limit: '20' } })
      if (!res.ok) throw new Error(await readError(res))
      const data = await res.json()
      return data.logs
    },
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: JOBS_KEY })
    queryClient.invalidateQueries({ queryKey: LOGS_KEY })
  }

  const create = useMutation({
    mutationFn: async () => {
      const res = await client.api.cron.$post({
        json: {
          id: form.id.trim(),
          name: form.name.trim(),
          schedule: form.schedule.trim(),
          prompt: form.prompt.trim(),
        },
      })
      if (!res.ok) throw new Error(await readError(res))
    },
    onSuccess: () => {
      setForm({ id: '', name: '', schedule: 'every 5m', prompt: '' })
      refresh()
    },
  })

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await client.api.cron[':id'].$delete({ param: { id } })
      if (!res.ok) throw new Error(await readError(res))
    },
    onSuccess: refresh,
  })

  const run = useMutation({
    mutationFn: async (id: string) => {
      const res = await client.api.cron[':id'].run.$post({ param: { id } })
      if (!res.ok) throw new Error(await readError(res))
      const data = await res.json()
      return data.output
    },
    onSuccess: refresh,
  })

  const toggle = useMutation({
    mutationFn: async (job: { id: string; enabled: boolean }) => {
      const res = job.enabled
        ? await client.api.cron[':id'].disable.$post({ param: { id: job.id } })
        : await client.api.cron[':id'].enable.$post({ param: { id: job.id } })
      if (!res.ok) throw new Error(await readError(res))
    },
    onSuccess: refresh,
  })

  const onCreate = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }

  const jobs = jobsQuery.data ?? []
  const logs = logsQuery.data ?? []

  return (
    <main className="mx-auto max-w-5xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">定时任务</h1>
        <span className="text-sm text-gray-500">
          共 {jobs.length} 个 · 启用 {jobs.filter((job) => job.config.enabled).length} 个
        </span>
      </div>

      <section className="mb-8 rounded border border-gray-200 p-4">
        <h2 className="mb-3 font-semibold">新建任务</h2>
        <form onSubmit={onCreate} className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <input
            className="rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="任务 ID，如 daily-report"
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
          />
          <input
            className="rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="任务名称"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="rounded border border-gray-300 px-3 py-2 font-mono text-sm"
            placeholder='调度：cron("0 9 * * *") / every 30s / ISO 时间戳'
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
          />
          <textarea
            className="h-20 rounded border border-gray-300 px-3 py-2 font-mono text-sm md:col-span-2"
            placeholder="执行时发给 Agent 的 prompt"
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          />
          <div className="md:col-span-2">
            <button
              type="submit"
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
              disabled={
                create.isPending ||
                !form.id.trim() ||
                !form.name.trim() ||
                !form.schedule.trim() ||
                !form.prompt.trim()
              }
            >
              {create.isPending ? '创建中…' : '创建'}
            </button>
            {create.isError && <p className="mt-2 text-sm text-red-600">{create.error.message}</p>}
          </div>
        </form>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 font-semibold">任务列表</h2>
        {jobsQuery.isPending && <p className="text-gray-500">加载中…</p>}
        {jobsQuery.isError && <p className="text-red-600">加载失败。</p>}
        {!jobsQuery.isPending && jobs.length === 0 && (
          <p className="text-gray-500">还没有定时任务。</p>
        )}
        {jobs.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-600">
                <th className="py-2 pr-3">ID / 名称</th>
                <th className="py-2 pr-3">调度</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2 pr-3">上次执行</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.config.id} className="border-b border-gray-100 align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{job.config.id}</div>
                    <div className="text-gray-600">{job.config.name}</div>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{job.config.schedule}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        STATUS_STYLE[job.status] ?? 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {STATUS_LABEL[job.status] ?? job.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-gray-600">
                    {job.lastRun ? (
                      <>
                        <div>
                          {job.lastRun.status} @ {new Date(job.lastRun.startedAt).toLocaleString()}
                        </div>
                        <div className="max-w-xs truncate" title={job.lastRun.output}>
                          {job.lastRun.output || job.lastRun.error || '-'}
                        </div>
                      </>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      className="mr-3 text-gray-700 underline disabled:opacity-50"
                      disabled={run.isPending}
                      onClick={() => run.mutate(job.config.id)}
                    >
                      执行
                    </button>
                    <button
                      type="button"
                      className="mr-3 text-gray-700 underline disabled:opacity-50"
                      disabled={toggle.isPending}
                      onClick={() =>
                        toggle.mutate({ id: job.config.id, enabled: job.config.enabled })
                      }
                    >
                      {job.config.enabled ? '禁用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="text-red-600 underline disabled:opacity-50"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`删除任务 ${job.config.id}？该操作不可恢复。`)) {
                          remove.mutate(job.config.id)
                        }
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {run.isError && <p className="mt-2 text-sm text-red-600">{run.error.message}</p>}
        {toggle.isError && <p className="mt-2 text-sm text-red-600">{toggle.error.message}</p>}
        {remove.isError && <p className="mt-2 text-sm text-red-600">{remove.error.message}</p>}
        {run.data !== undefined && (
          <pre className="mt-3 whitespace-pre-wrap rounded bg-gray-100 p-3 text-sm">
            {run.data || '（无输出）'}
          </pre>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-semibold">最近执行日志</h2>
        {logsQuery.isPending && <p className="text-gray-500">加载中…</p>}
        {!logsQuery.isPending && logs.length === 0 && (
          <p className="text-gray-500">暂无执行记录。</p>
        )}
        {logs.length > 0 && (
          <ul className="space-y-2 text-sm">
            {logs.map((log) => (
              <li
                key={`${log.jobId}-${log.startedAt}`}
                className="rounded border border-gray-200 p-3"
              >
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>
                    <span className={log.status === 'success' ? 'text-green-700' : 'text-red-600'}>
                      {log.status}
                    </span>{' '}
                    · {log.jobId}
                  </span>
                  <span>{new Date(log.startedAt).toLocaleString()}</span>
                </div>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">
                  {log.output || log.error || '-'}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
