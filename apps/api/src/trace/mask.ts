/** 单个字符串值的上报上限：避免工具的大段输出撑爆单条 span */
const MAX_STRING_LENGTH = 8 * 1024
const TRUNCATED_SUFFIX = '…[truncated]'
const SECRET_KEY = /api[-_]?key|token(?!s)|secret|password|authorization/i

/** 按字段名递归脱敏：上下文里可能夹带 API Key / Token / 密码 */
export function redactSensitive(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactSensitive(childValue, childKey),
      ]),
    )
  }
  return value
}

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED_SUFFIX}`
    : value
}

/** 递归截断超长字符串，保留结构 */
function truncateStrings(value: unknown): unknown {
  if (typeof value === 'string') return truncateString(value)
  if (Array.isArray(value)) return value.map(truncateStrings)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        truncateStrings(child),
      ]),
    )
  }
  return value
}

/** Langfuse span processor 的 mask 钩子：入参是属性值的 JSON 字符串 */
export function maskTraceData({ data }: { data: string }): string {
  try {
    return JSON.stringify(truncateStrings(redactSensitive(JSON.parse(data))))
  } catch {
    // 不是合法 JSON 时按原始字符串截断，而不是丢弃
    return truncateString(data)
  }
}
