import type { CalloutData } from 'api/genui/spec'

const LEVEL_STYLES = {
  info: 'border-accent bg-accent/10 text-foreground',
  warn: 'border-tertiary bg-tertiary/25 text-foreground',
  danger: 'border-destructive bg-destructive/10 text-destructive',
  success: 'border-quaternary bg-quaternary/20 text-foreground',
} as const

/** 一句结论 + 高亮：只有纯文本，不渲染任何 HTML */
export function Callout({ text, level = 'info' }: CalloutData) {
  return (
    <div className={`rounded-md border-2 px-4 py-3 text-sm leading-relaxed ${LEVEL_STYLES[level]}`}>
      {text}
    </div>
  )
}
