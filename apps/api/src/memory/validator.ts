import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { MemoryEntry, MemoryType } from './store'

/**
 * 记忆体检：从内容里找出"会变坏"的信号。
 * - stale_path：记忆里引用的文件已不存在（过期，最容易让 Agent 自信地做错决策）
 * - never_used：超过该类记忆的保质期没被 read 过（信噪比下降）
 * - duplicate_name：同名记忆并存（新旧冲突，行为漂移）
 * - expired：已过 expiresAt，不再注入系统提示，但还占着记忆库
 */

export type ValidationIssueKind = 'stale_path' | 'never_used' | 'duplicate_name' | 'expired'

export interface ValidationIssue {
  kind: ValidationIssueKind
  message: string
}

export interface ValidationReport {
  entry: MemoryEntry
  issues: ValidationIssue[]
}

const PATH_RE = /(?<![\w/])([\w./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|sql|yml|yaml|toml|env|sh|py))/g

/** 提取记忆内容中出现的文件路径（URL 先剔除，避免把域名当成本地路径） */
export function extractPaths(content: string): string[] {
  const text = content.replace(/https?:\/\/\S+/g, ' ')
  const paths = new Set<string>()
  for (const match of text.matchAll(PATH_RE)) {
    const path = match[1]
    if (path) paths.add(path)
  }
  return Array.from(paths)
}

/** 不同类型的记忆有不同的保质期（天） */
const TTL_BY_TYPE: Record<MemoryType, number> = {
  user: 365, // 用户偏好几乎不过期
  feedback: 90, // 纠正反馈保留 3 个月
  project: 30, // 项目动态变化快
  reference: 14, // 外部资源引用需要频繁刷新
}

/**
 * 单条记忆的体检项。
 * baseDirs 是相对路径的候选解析根（工作区 + 进程 cwd），任一根存在即视为有效，
 * 避免记忆里的路径写法不同导致系统性误报。
 */
export function validateEntry(entry: MemoryEntry, baseDirs: string[] = ['.']): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const p of extractPaths(entry.content)) {
    const exists = isAbsolute(p)
      ? existsSync(p)
      : baseDirs.some((dir) => existsSync(resolve(dir, p)))
    if (!exists) {
      issues.push({ kind: 'stale_path', message: `引用的路径不存在：${p}` })
    }
  }

  if (entry.expiresAt && entry.expiresAt.getTime() <= Date.now()) {
    issues.push({
      kind: 'expired',
      message: `已于 ${entry.expiresAt.toISOString().slice(0, 10)} 过期，不再注入系统提示`,
    })
  }

  // 从未读过则以最后写入时间为起点计时
  const lastTouched = entry.lastReadAt ?? entry.updatedAt
  const ttlDays = TTL_BY_TYPE[entry.type]
  const days = (Date.now() - lastTouched.getTime()) / (1000 * 60 * 60 * 24)
  if (days > ttlDays) {
    issues.push({
      kind: 'never_used',
      message: `已 ${Math.floor(days)} 天没被读过，超过 ${entry.type} 类型的 ${ttlDays} 天保质期`,
    })
  }

  return issues
}

export function lintAll(entries: MemoryEntry[], baseDirs: string[] = ['.']): ValidationReport[] {
  // 同名只在未过期条目间算重复：过期行允许同名（save 会新建一行）
  const activeNameCount = new Map<string, number>()
  for (const entry of entries) {
    const expired = entry.expiresAt !== null && entry.expiresAt.getTime() <= Date.now()
    if (expired) continue
    activeNameCount.set(entry.name, (activeNameCount.get(entry.name) ?? 0) + 1)
  }

  const reports: ValidationReport[] = []
  for (const entry of entries) {
    const issues = validateEntry(entry, baseDirs)
    const count = activeNameCount.get(entry.name) ?? 0
    if (count > 1) {
      issues.push({ kind: 'duplicate_name', message: `存在 ${count} 条同名记忆，可能需要合并` })
    }
    if (issues.length > 0) reports.push({ entry, issues })
  }

  return reports
}
