import { API, type CommandHandler } from './types'

/**
 * /memory：持久记忆管理面板。
 * 拉取全部记忆（含已过期），按四类分组展示，支持删除。
 */
export const memoryCommand: CommandHandler = async (cmd, { showPanel }) => {
  if (cmd !== '/memory') return false
  const data = await fetch(`${API}/api/memory`).then((res) => res.json())
  showPanel({ kind: 'memory', items: data.memories ?? [] })
  return true
}
