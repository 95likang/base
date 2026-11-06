import { apiFetch } from '@/lib/http'
import type { CommandHandler, UsageTotals } from './types'

/**
 * /usage：成本用量面板。
 * 默认查当前会话；/usage all 查进程累计。
 */
export const usageCommand: CommandHandler = async (cmd, { chatId, showPanel }) => {
  if (cmd !== '/usage' && cmd !== '/usage all') return false
  const all = cmd === '/usage all'
  const query = !all && chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''
  const data = await apiFetch<{ totals: UsageTotals }>(`/api/usage${query}`)
  showPanel({
    kind: 'usage',
    totals: data.totals,
    title: all ? '进程累计' : chatId ? '当前会话' : '进程累计',
  })
  return true
}
