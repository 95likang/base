import { API, type CommandHandler } from './types'

/** /context：上下文占用快照面板 */
export const contextCommand: CommandHandler = async (cmd, { chatId, showPanel }) => {
  if (cmd !== '/context') return false
  const query = chatId ? `?chatId=${chatId}` : ''
  const snapshot = await fetch(`${API}/api/usage/context${query}`).then((res) => res.json())
  showPanel({ kind: 'context', snapshot })
  return true
}
