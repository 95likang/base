import type { CalloutData } from 'api/genui/spec'

const LEVEL_STYLES = {
  info: 'border-blue-200 bg-blue-50 text-blue-900',
  warn: 'border-amber-300 bg-amber-50 text-amber-900',
  danger: 'border-red-300 bg-red-50 text-red-900',
  success: 'border-green-300 bg-green-50 text-green-900',
} as const

/** 一句结论 + 高亮：只有纯文本，不渲染任何 HTML */
export function Callout({ text, level = 'info' }: CalloutData) {
  return <div className={`rounded-lg border px-4 py-3 text-sm ${LEVEL_STYLES[level]}`}>{text}</div>
}
