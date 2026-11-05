'use client'

import { useEffect, useId, useRef } from 'react'
import { Button } from '@/components/ui/button'

type ConfirmDialogProps = {
  open: boolean
  title: string
  description: string
  onConfirm: () => void
  onCancel: () => void
}

/** 用原生 dialog 拿到焦点陷阱、Esc 与 aria-modal，不额外引依赖 */
export function ConfirmDialog({
  open,
  title,
  description,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl border-2 border-foreground bg-card p-5 text-foreground shadow-pop-lg backdrop:bg-foreground/40"
    >
      <h2 id={titleId} className="text-lg">
        {title}
      </h2>
      <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <div className="mt-5 flex gap-2">
        <Button variant="outline" className="h-12 flex-1" onClick={onCancel}>
          取消
        </Button>
        <Button variant="destructive" className="h-12 flex-1" onClick={onConfirm}>
          删除
        </Button>
      </div>
    </dialog>
  )
}
