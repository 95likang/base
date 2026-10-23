/**
 * bash 命令风险分级。
 * 纯正则启发式：挡得住常见误操作和 prompt injection 诱导，挡不住刻意混淆
 * （`command rm`、变量拼接、编码后再执行）。它是执行前的拦截线，不是沙箱。
 */
export type RiskLevel = 'safe' | 'moderate' | 'dangerous'

export interface ClassifyResult {
  level: RiskLevel
  reason?: string
}

/**
 * 危险命令：直接拒绝执行。
 * 这些要么是误操作，要么是 prompt injection 诱导模型干的。
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force)/, reason: '强制删除文件' },
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: '递归删除' },
  { pattern: /\bsudo\b/, reason: '提权操作' },
  { pattern: /\bmkfs\b/, reason: '格式化磁盘' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写设备' },
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, reason: 'Fork bomb' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: '覆写磁盘设备' },
  { pattern: /\bchmod\s+777\b/, reason: '开放所有权限' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: '远程脚本执行' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/, reason: '远程脚本执行' },
  { pattern: /\beval\b/, reason: 'eval 动态执行' },
  { pattern: />\s*\/etc\//, reason: '覆写系统配置' },
]

/** 中风险命令：只告警不拦截（全拦的话 Agent 基本干不了活） */
const MODERATE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b/, reason: '删除文件' },
  { pattern: /\bmv\b/, reason: '移动/重命名文件' },
  { pattern: /\bchmod\b/, reason: '修改权限' },
  { pattern: /\bchown\b/, reason: '修改所有者' },
  { pattern: /\bkill\b/, reason: '终止进程' },
  { pattern: /\bpkill\b/, reason: '批量终止进程' },
  { pattern: /\bgit\s+push\b/, reason: 'Git 推送' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Git 硬重置' },
  { pattern: /\bnpm\s+publish\b/, reason: '发布 npm 包' },
  { pattern: /\bdocker\s+rm\b/, reason: '删除容器' },
]

/** 按危险程度给 bash 命令分级，危险模式优先命中 */
export function classifyBashCommand(command: string): ClassifyResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'dangerous', reason }
    }
  }

  for (const { pattern, reason } of MODERATE_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'moderate', reason }
    }
  }

  return { level: 'safe' }
}
