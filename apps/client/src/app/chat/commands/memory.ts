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

/**
 * /lint：记忆库体检。列出引用路径失效、长期未读、同名重复的条目。
 */
export const lintCommand: CommandHandler = async (cmd, { showPanel }) => {
  if (cmd !== '/lint') return false
  const data = await fetch(`${API}/api/memory/lint`).then((res) => res.json())
  showPanel({ kind: 'lint', total: data.total ?? 0, reports: data.reports ?? [] })
  return true
}

const DREAM_PROMPT = [
  '请对记忆库做一次完整的整理（dream），按以下阶段执行：',
  '',
  '**阶段 1：定位** — 调用 memory 工具的 lint action 扫描全库（lint 结果已包含问题清单，不需要逐条 read）。',
  '**阶段 2：整理** — 根据 lint 报告直接操作：',
  '  - 引用路径失效 / 已过期 / 长期未读：确认内容确实过时后，用 memory delete（传 id）删掉',
  '  - 同名重复：用 memory save 保存合并后的版本（同名自动覆盖），再 delete 多余的',
  '  - 内容仍有效但描述不准确：用 memory save 覆盖更新',
  '  - 路径失效但内容仍有价值：修正内容里的路径后再 save',
  '**阶段 3：报告** — 用一段文字总结这次整理做了什么（删除 / 合并 / 更新各几条）。',
  '',
  '注意：memory 的 read 和 delete 都需要传 id（来自 lint 报告或系统提示里的索引），不是 name。',
  '不要删除仍然有效的用户偏好和行为反馈。',
].join('\n')

/**
 * /dream：记忆自动整理。把整理提示词作为一条用户消息送进正常 agent 循环，
 * 由模型调用 memory 的 lint / delete / save 完成清理并输出报告。
 */
export const dreamCommand: CommandHandler = (cmd, { send }) => {
  if (cmd !== '/dream') return false
  send(DREAM_PROMPT)
  return true
}
