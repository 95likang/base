'use client'

import { useState } from 'react'
import { apiFetch } from '@/lib/http'
import type { ContextSnapshot, LintReport, MemoryItem, UsageTotals } from '../commands/types'

const fmt = (n: number) => n.toLocaleString('en-US')

/** 上下文占用面板：输入 /context 时展示在消息区顶部（可关闭） */
export function ContextPanel({
  snapshot,
  onClose,
}: {
  snapshot: ContextSnapshot
  onClose: () => void
}) {
  return (
    <div className="rounded-xl border-2 border-foreground bg-card p-4 text-sm shadow-pop-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">
          Context · {snapshot.modelId} · 窗口 {fmt(snapshot.windowTokens)} tokens
        </p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {snapshot.sections.map((section) => (
          <div key={section.name} className="flex items-center gap-2">
            <span className="w-32 shrink-0 truncate text-xs text-gray-600" title={section.name}>
              {section.name}
            </span>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums">
              {fmt(section.tokens)}
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded bg-gray-100">
              <div
                className="h-full rounded bg-gray-400"
                style={{
                  width: `${Math.min(100, (section.tokens / snapshot.windowTokens) * 100)}%`,
                }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-gray-500">
              {((section.tokens / snapshot.windowTokens) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t pt-2 text-xs text-gray-600">
        已用 <span className="font-medium text-gray-900">{fmt(snapshot.usedTokens)}</span>（
        {snapshot.usedPercent}%）· 剩余 {fmt(snapshot.freeTokens)} tokens
      </div>
    </div>
  )
}

/** 成本用量面板：输入 /usage（当前会话）或 /usage all（进程累计）时展示 */
export function UsagePanel({
  totals,
  title,
  onClose,
}: {
  totals: UsageTotals
  title: string
  onClose: () => void
}) {
  const savedPct =
    totals.baselineCost > 0 ? Math.round((totals.savedCost / totals.baselineCost) * 100) : 0
  const rows = [
    { label: 'input', value: totals.inputTokens },
    { label: 'cache 写入', value: totals.cacheWriteTokens },
    { label: 'cache 读取', value: totals.cacheReadTokens },
    { label: 'output', value: totals.outputTokens },
  ]
  const max = Math.max(...rows.map((r) => r.value), 1)

  return (
    <div className="rounded-xl border-2 border-foreground bg-card p-4 text-sm shadow-pop-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">
          Usage · {title} {fmt(totals.steps)} 步
        </p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-gray-600">{row.label}</span>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums">{fmt(row.value)}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded bg-gray-100">
              <div
                className="h-full rounded bg-gray-400"
                style={{ width: `${(row.value / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t pt-2 text-xs text-gray-600">
        cache 命中率{' '}
        <span className="font-medium text-gray-900">{(totals.hitRate * 100).toFixed(1)}%</span>
        {' · '}花费 <span className="font-medium text-gray-900">${totals.cost.toFixed(4)}</span>
        {' · '}无 cache 假想 ${totals.baselineCost.toFixed(4)}
        {' · '}省 <span className="font-medium text-gray-900">${totals.savedCost.toFixed(4)}</span>
        {savedPct > 0 ? ` (-${savedPct}%)` : ''}
      </div>
    </div>
  )
}

/** 记忆管理面板：输入 /memory 时展示，按四类分组，支持删除 */
export function MemoryPanel({ items, onClose }: { items: MemoryItem[]; onClose: () => void }) {
  const [list, setList] = useState(items)
  const [error, setError] = useState('')

  /** 删除成功才从列表移除：接口失败时不能让用户以为已经删掉了 */
  const remove = async (id: string) => {
    setError('')
    try {
      await apiFetch(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setList((prev) => prev.filter((m) => m.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败，请重试。')
    }
  }

  const labels: Record<MemoryItem['type'], string> = {
    user: '用户画像',
    feedback: '行为反馈',
    project: '项目动态',
    reference: '外部资源',
  }
  const groups = (['user', 'feedback', 'project', 'reference'] as const).map((type) => ({
    type,
    entries: list.filter((m) => m.type === type),
  }))

  return (
    <div className="rounded-xl border-2 border-foreground bg-card p-4 text-sm shadow-pop-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">Memory · 共 {list.length} 条</p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      {error ? (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {list.length === 0 && (
        <p className="text-xs text-gray-500">
          还没有任何记忆。对话中透露偏好/决策/渠道时，AI 会自动保存。
        </p>
      )}
      <div className="flex flex-col gap-3">
        {groups
          .filter((g) => g.entries.length > 0)
          .map((group) => (
            <div key={group.type}>
              <p className="mb-1 text-xs font-medium text-gray-500">{labels[group.type]}</p>
              <div className="flex flex-col gap-1.5">
                {group.entries.map((m) => {
                  const expired = m.expiresAt !== null && new Date(m.expiresAt) < new Date()
                  return (
                    <div
                      key={m.id}
                      className="group flex items-start gap-2 rounded bg-gray-50 px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium" title={m.name}>
                          {m.name}
                          {expired && <span className="ml-1 text-gray-400">（已过期）</span>}
                        </p>
                        <p className="truncate text-xs text-gray-500" title={m.description}>
                          {m.description}
                          {m.expiresAt && !expired ? ` · 截止 ${m.expiresAt.slice(0, 10)}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label="删除记忆"
                        onClick={() => remove(m.id)}
                        className="shrink-0 text-gray-300 hover:text-red-600"
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

/** 记忆体检面板：输入 /lint 时展示，列出每条记忆的失效路径、长期未读、同名重复 */
export function LintPanel({
  total,
  reports,
  onClose,
}: {
  total: number
  reports: LintReport[]
  onClose: () => void
}) {
  return (
    <div className="rounded-xl border-2 border-foreground bg-card p-4 text-sm shadow-pop-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">
          记忆体检 · 共 {total} 条
          {reports.length > 0 ? ` · ${reports.length} 条有警告` : ' · 未发现问题'}
        </p>
        <button
          type="button"
          aria-label="关闭面板"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      {reports.length === 0 && (
        <p className="text-xs text-gray-500">
          记忆库健康。体检项：引用路径是否还存在、是否已过期、是否长期未被读取、是否有同名重复。
        </p>
      )}
      <div className="flex flex-col gap-2">
        {reports.map((report) => (
          <div key={report.entry.id} className="rounded bg-amber-50 px-2 py-1.5 text-xs">
            <p className="font-medium">
              [{report.entry.type}] {report.entry.name}
            </p>
            {report.issues.map((issue) => (
              <p key={`${issue.kind}:${issue.message}`} className="text-gray-600">
                · {issue.kind}：{issue.message}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
