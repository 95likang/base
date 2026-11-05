'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

/**
 * 删除计划。列表页与详情页共用：
 * 详情页传 redirectTo="/plans"，删除后回到列表；列表页只刷新。
 */
export function DeletePlanButton({ id, redirectTo }: { id: string; redirectTo?: string }) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    if (!window.confirm('确定删除这个计划？删除后无法恢复。')) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/roadmaps/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string }
        } | null
        throw new Error(body?.error?.message ?? '删除失败，请重试')
      }
      if (redirectTo) router.push(redirectTo)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败，请重试')
      setDeleting(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={remove}
        disabled={deleting}
        className="shrink-0 text-xs font-bold text-destructive underline-offset-4 hover:underline disabled:opacity-40"
      >
        {deleting ? '删除中…' : '删除'}
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  )
}
