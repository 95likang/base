import { existsSync, readFileSync } from 'node:fs'
import { CONFIG_FILE } from './constants'
import { type SuperAgentConfig, SuperAgentConfigSchema } from './schema'

// 导入期就要读取配置，显式加载 .env，不依赖其他模块的副作用顺序
try {
  process.loadEnvFile?.()
} catch {
  // .env 可选：不存在时全部使用系统环境变量
}

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g
/** 无状态版本，用于检测字符串里是否还残留占位符 */
const ENV_PLACEHOLDER_RE = /\$\{[A-Z_][A-Z0-9_]*\}/

/** 递归把字符串里的 ${ENV_VAR} 替换成环境变量值（未设置时保留原样并告警） */
function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(ENV_VAR_RE, (match, name: string) => {
      const value = process.env[name]
      if (value === undefined) {
        console.warn(`  ⚠ 环境变量 ${name} 未设置，保留原值 ${match}`)
        return match
      }
      return value
    })
  }
  if (Array.isArray(obj)) return obj.map(substituteEnvVars)
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVars(value)
    }
    return result
  }
  return obj
}

/** 递归找出替换后仍残留 ${VAR} 的字段路径（说明环境变量缺失或名字写错） */
function findUnresolvedPlaceholders(obj: unknown, path: string[] = []): string[] {
  if (typeof obj === 'string') {
    return ENV_PLACEHOLDER_RE.test(obj) ? [path.join('.') || '(根)'] : []
  }
  if (Array.isArray(obj)) {
    return obj.flatMap((item, index) => findUnresolvedPlaceholders(item, [...path, String(index)]))
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
      findUnresolvedPlaceholders(value, [...path, key]),
    )
  }
  return []
}

/**
 * 读取 → 替换 ${ENV_VAR} → Zod 校验 + 默认值合并。
 * 文件不存在时直接用默认配置；内容非法时抛错让启动失败（fail fast）。
 */
export function loadConfig(path = CONFIG_FILE): SuperAgentConfig {
  if (!existsSync(path)) {
    console.log(`  未找到 ${path}，使用默认配置（可运行 pnpm --filter api config:init 生成）`)
    return SuperAgentConfigSchema.parse({})
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    throw new Error(`解析 ${path} 失败: ${(err as Error).message}`)
  }

  const result = SuperAgentConfigSchema.safeParse(substituteEnvVars(raw))
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(根)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`${path} 配置校验失败:\n${issues}`)
  }

  // 占位符没被替换掉说明环境变量缺失，此时继续启动只会拿字面量当密钥/连接串用
  const unresolved = findUnresolvedPlaceholders(result.data)
  if (unresolved.length > 0) {
    const fields = unresolved.map((field) => `  ${field}: 引用的环境变量未设置`).join('\n')
    throw new Error(`${path} 配置校验失败:\n${fields}`)
  }

  console.log(`  ✓ 已加载 ${path}`)
  return result.data
}

/** 进程级单例：各子系统共享同一份配置 */
export const config = loadConfig()
