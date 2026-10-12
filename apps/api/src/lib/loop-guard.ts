import { createHash } from 'node:crypto'

interface ToolCallRecord {
  toolName: string
  argsHash: string
  resultHash?: string
}

export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker'

export type DetectionResult =
  | { stuck: false }
  | {
      stuck: true
      level: 'warning' | 'critical'
      detector: DetectorKind
      count: number
      message: string
    }

/** 历史窗口大小（覆盖 MAX_STEPS=15 内的所有调用，含并行工具） */
const HISTORY_SIZE = 60
// 阈值按 agentLoop MAX_STEPS=15 匹配：detect 先于 recordCall 执行，
// 即第 6 次同签名调用触发 warning，第 9 次触发 critical。
const WARNING_THRESHOLD = 5
const CRITICAL_THRESHOLD = 8
// no-progress（同调用+同结果）是比 generic_repeat 更强的循环证据，必须更早触发，
// 否则会被 generic 的 critical 提前熔断而永远不可达。
// 取 6：warning(5) 和 critical(8) 之间。
const BREAKER_THRESHOLD = 6

/** 键序无关的序列化：{a:1,b:2} 与 {b:2,a:1} 生成相同字符串 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`
}

function hashResult(result: unknown): string {
  return hash(stableStringify(result))
}

/**
 * 循环检测器（请求级实例，必须每次 agentLoop 新建，不能全局共享）。
 *
 * 三个检测器：
 * - generic_repeat：同工具同参数重复调用
 * - ping_pong：两个调用交替往复（A→B→A→B）
 * - global_circuit_breaker：同调用 + 同结果（无进展重试，重试毫无意义）
 */
export function createLoopGuard() {
  const history: ToolCallRecord[] = []

  function recordCall(toolName: string, params: unknown): void {
    history.push({
      toolName,
      argsHash: hashToolCall(toolName, params),
    })
    if (history.length > HISTORY_SIZE) history.shift()
  }

  /** 回填结果哈希：找到该签名最近一条还没有结果的记录 */
  function recordResult(toolName: string, params: unknown, result: unknown): void {
    const argsHash = hashToolCall(toolName, params)
    const resultHash = hashResult(result)
    for (let i = history.length - 1; i >= 0; i--) {
      const r = history[i]
      if (r && r.toolName === toolName && r.argsHash === argsHash && !r.resultHash) {
        r.resultHash = resultHash
        break
      }
    }
  }

  /** 同签名连续 N 次拿到完全相同的结果 */
  function getNoProgressStreak(toolName: string, argsHash: string): number {
    let streak = 0
    let lastResultHash: string | undefined
    for (let i = history.length - 1; i >= 0; i--) {
      const r = history[i]
      if (!r || r.toolName !== toolName || r.argsHash !== argsHash) continue
      if (!r.resultHash) continue
      if (!lastResultHash) {
        lastResultHash = r.resultHash
        streak = 1
        continue
      }
      if (r.resultHash !== lastResultHash) break
      streak++
    }
    return streak
  }

  /** 两个签名交替出现的最长连续段长度 */
  function getPingPongCount(currentHash: string): number {
    if (history.length < 2) return 0
    const last = history[history.length - 1]
    if (!last || last.argsHash === currentHash) return 0

    // 从最近的两个不同签名构建交替模式，向历史方向校验。
    // 期望序列（新→旧）：other, currentHash, other, currentHash, ...
    const other = last.argsHash
    let count = 0
    for (let i = history.length - 1; i >= 0; i--) {
      const expected = count % 2 === 0 ? other : currentHash
      if (history[i]?.argsHash !== expected) break
      count++
    }
    // 历史已匹配 count 个；当前调用恰好接在模式后面（成为 currentHash 位），计入
    return count >= 2 ? count + 1 : 0
  }

  /**
   * 检测当前调用是否构成循环。应在 recordCall 之前调用：
   * 返回的 count 均为"历史中已出现的次数"。
   */
  function detect(toolName: string, params: unknown): DetectionResult {
    const argsHash = hashToolCall(toolName, params)

    const noProgress = getNoProgressStreak(toolName, argsHash)
    if (noProgress >= BREAKER_THRESHOLD) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'global_circuit_breaker',
        count: noProgress,
        message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
      }
    }

    const pingPong = getPingPongCount(argsHash)
    if (pingPong >= CRITICAL_THRESHOLD) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'ping_pong',
        count: pingPong,
        message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
      }
    }
    if (pingPong >= WARNING_THRESHOLD) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'ping_pong',
        count: pingPong,
        message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
      }
    }

    const recentCount = history.filter(
      (h) => h.toolName === toolName && h.argsHash === argsHash,
    ).length
    if (recentCount >= CRITICAL_THRESHOLD) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'generic_repeat',
        count: recentCount,
        message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
      }
    }
    if (recentCount >= WARNING_THRESHOLD) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'generic_repeat',
        count: recentCount,
        message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
      }
    }

    return { stuck: false }
  }

  return {
    detect,
    recordCall,
    recordResult,
    /**
     * 记录当前历史快照（步骤开始前调用），重试失败步骤时用 restore 回滚。
     *
     * 注意：在 agentLoop 当前的 `forwarded` 守卫下（recordCall 与 send 同步执行，
     * 未转发则不可能有记录），restore 实际是空操作。保留这对方法是为未来的
     * "缓冲到步末再转发"模式预留事务边界——那时 recordCall 已发生而内容未转发，
     * 回滚从空操作变为必需，缺失会导致重试重放的调用被双重计数而误熔断。
     */
    snapshot: (): ToolCallRecord[] => history.slice(),
    /** 回滚到快照：失败尝试中的调用记录不能留在窗口里，否则重试的相同调用会被双重计数 */
    restore: (mark: ToolCallRecord[]) => {
      history.length = 0
      history.push(...mark)
    },
  }
}
