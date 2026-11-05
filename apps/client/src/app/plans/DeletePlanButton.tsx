'use client'

import { Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

/**
 * 删除计划。列表页与详情页共用：
 * 详情页传 redirectTo="/plans"，删除后回到列表；列表页只刷新。
 */
export function DeletePlanButton({ id, redirectTo }: { id: string; redirectTo?: string }) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setConfirming(false)
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/roadmaps/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string }
        } | null
        throw new Error(body?.error?.message ?? '删除失败，请重试。')
      }
      if (redirectTo) router.push(redirectTo)
      else router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败，请重试。')
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label={deleting ? '正在删除计划' : '删除计划'}
        title={deleting ? '正在删除计划' : '删除计划'}
        disabled={deleting}
        onClick={() => setConfirming(true)}
        className="text-destructive hover:bg-destructive/10"
      >
        <Trash2 />
      </Button>
      {error ? (
        <span className="max-w-40 text-right text-xs leading-snug text-destructive">{error}</span>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="删除这个计划？"
        description="删除后无法恢复，已经完成的训练记录也会一起消失。"
        onConfirm={remove}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}
