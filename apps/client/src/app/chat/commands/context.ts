import { apiFetch } from '@/lib/http'
import type { CommandHandler, ContextSnapshot } from './types'

/** /context：上下文占用快照面板 */
export const contextCommand: CommandHandler = async (cmd, { chatId, showPanel }) => {
  if (cmd !== '/context') return false
  const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''
  const snapshot = await apiFetch<ContextSnapshot>(`/api/usage/context${query}`)
  showPanel({ kind: 'context', snapshot })
  return true
}
