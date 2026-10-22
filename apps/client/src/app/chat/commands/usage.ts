import { API, type CommandHandler } from './types'

/**
 * /usage：成本用量面板。
 * 默认查当前会话；/usage all 查进程累计。
 */
export const usageCommand: CommandHandler = async (cmd, { chatId, showPanel }) => {
  if (cmd !== '/usage' && cmd !== '/usage all') return false
  const all = cmd === '/usage all'
  const query = !all && chatId ? `?chatId=${chatId}` : ''
  const data = await fetch(`${API}/api/usage${query}`).then((res) => res.json())
  showPanel({
    kind: 'usage',
    totals: data.totals,
    title: all ? '进程累计' : chatId ? '当前会话' : '进程累计',
  })
  return true
}
