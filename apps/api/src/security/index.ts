import { config } from '../config/loader'
import { HookPipeline } from './hooks'
import type { Role } from './roles'

/** 进程级 Hook 管线：新建的 registry 共享同一份 hook 注册 */
export const hookPipeline = new HookPipeline()

// 示例 Pre Hook: 写文件前记录审计日志（配置 security.auditLog 关闭时不注册）
if (config.security.auditLog) {
  hookPipeline.registerPre('audit-log', (toolName, input) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = (input as { path?: string } | undefined)?.path ?? 'unknown'
      console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`)
    }
    return { action: 'allow' }
  })
}

// 示例 Post Hook: 给 bash 输出加时间戳（配置 security.bashTimestamp 关闭时不注册）
if (config.security.bashTimestamp) {
  hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
    if (toolName === 'bash') {
      return {
        action: 'modify',
        modifiedOutput: `[${new Date().toISOString()}]\n${output}`,
      }
    }
    return { action: 'allow' }
  })
}

/**
 * 进程级当前角色：registry 按请求创建，新建时继承这里的值。
 * 与 CLI 的 /role 语义一致，Web 端由管理后台切换（PATCH /api/security/role）。
 */
let currentRole: Role = config.security.defaultRole

export function getRole(): Role {
  return currentRole
}

export function setRole(role: Role): void {
  currentRole = role
}
