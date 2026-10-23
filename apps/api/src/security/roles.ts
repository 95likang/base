/** 三级角色：owner 全部工具；collaborator 除 bash 外全部；guest 只读工具 */
export const ROLES = ['owner', 'collaborator', 'guest'] as const
export type Role = (typeof ROLES)[number]

const TOOL_ACCESS: Record<Role, { allow: string[] | '*'; deny: string[] }> = {
  owner: {
    allow: '*',
    deny: [],
  },
  collaborator: {
    allow: '*',
    // bash 能干的事太多，协作者默认不给
    deny: ['bash'],
  },
  guest: {
    allow: [
      'getWeather',
      'calculator',
      'read_file',
      'list_directory',
      'glob',
      'grep',
      'rag_search',
    ],
    deny: [],
  },
}

/** 角色是否允许使用该工具（deny 优先于 allow） */
export function canUseTool(role: Role, toolName: string): boolean {
  const access = TOOL_ACCESS[role]
  if (access.deny.includes(toolName)) return false
  if (access.allow === '*') return true
  return access.allow.includes(toolName)
}
