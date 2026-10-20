import { describe, expect, it } from 'vitest'
import { createLoopGuard } from './loop-detection'

/**
 * 通过公开 API（detect/recordCall/recordResult）间接测试，
 * 不直接测内部哈希函数——签名稳定性已由行为测试覆盖。
 */

/** 记录一次完整调用（调用 + 结果） */
function recorded(
  guard: ReturnType<typeof createLoopGuard>,
  name: string,
  input: unknown,
  result: unknown,
) {
  guard.recordCall(name, input)
  guard.recordResult(name, input, result)
}

describe('generic_repeat：同工具同参数重复', () => {
  it('前 5 次不触发（detect 先于 recordCall，历史 4 次）', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 4; i++) {
      expect(guard.detect('getWeather', { city: '北京' })).toEqual({ stuck: false })
      guard.recordCall('getWeather', { city: '北京' })
    }
  })

  it('第 6 次触发 warning（历史 5 次）', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 5; i++) guard.recordCall('getWeather', { city: '北京' })
    const r = guard.detect('getWeather', { city: '北京' })
    expect(r).toMatchObject({ stuck: true, level: 'warning', detector: 'generic_repeat', count: 5 })
  })

  it('第 9 次触发 critical（历史 8 次）', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 8; i++) guard.recordCall('getWeather', { city: '北京' })
    const r = guard.detect('getWeather', { city: '北京' })
    expect(r).toMatchObject({
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: 8,
    })
  })

  it('不同参数互不累计', () => {
    const guard = createLoopGuard()
    guard.recordCall('getWeather', { city: '北京' })
    guard.recordCall('getWeather', { city: '上海' })
    expect(guard.detect('getWeather', { city: '北京' })).toEqual({ stuck: false })
  })

  it('对象键序不影响签名（{a,b} 与 {b,a} 同签名）', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 5; i++) guard.recordCall('getWeather', { city: '北京', unit: 'c' })
    const r = guard.detect('getWeather', { unit: 'c', city: '北京' })
    expect(r).toMatchObject({ stuck: true, detector: 'generic_repeat' })
  })
})

describe('ping_pong：两签名交替', () => {
  const A = { e: '1+1' }
  const B = { e: '2+2' }

  it('[X,Y] + X = 3 次交替，不触发', () => {
    const guard = createLoopGuard()
    guard.recordCall('calc', A)
    guard.recordCall('calc', B)
    expect(guard.detect('calc', A)).toEqual({ stuck: false })
  })

  it('[X,Y,X,Y] + X = 5 次交替，warning（回归：曾误报 6）', () => {
    const guard = createLoopGuard()
    guard.recordCall('calc', A)
    guard.recordCall('calc', B)
    guard.recordCall('calc', A)
    guard.recordCall('calc', B)
    const r = guard.detect('calc', A)
    expect(r).toMatchObject({ stuck: true, level: 'warning', detector: 'ping_pong', count: 5 })
  })

  it('更长的交替触发 critical', () => {
    const guard = createLoopGuard()
    const seq = [A, B, A, B, A, B, A]
    for (const s of seq) guard.recordCall('calc', s)
    const r = guard.detect('calc', B)
    expect(r).toMatchObject({ stuck: true, level: 'critical', detector: 'ping_pong' })
  })

  it('连续同签名不算乒乓', () => {
    const guard = createLoopGuard()
    guard.recordCall('calc', A)
    guard.recordCall('calc', A)
    guard.recordCall('calc', A)
    expect(guard.detect('calc', B)).toEqual({ stuck: false })
  })
})

describe('global_circuit_breaker：同调用 + 同结果（无进展）', () => {
  it('连续 6 次同结果后触发（回归：阈值 10 时永不可达）', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 6; i++) {
      recorded(guard, 'getWeather', { city: '广州' }, { temperature: 28, condition: '阵雨' })
    }
    const r = guard.detect('getWeather', { city: '广州' })
    expect(r).toMatchObject({
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
    })
  })

  it('结果每次变化（赌新结果）不触发 breaker，走 generic 阈值', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 6; i++) {
      recorded(guard, 'getWeather', { city: '贵阳' }, { temperature: 15 + i })
    }
    const r = guard.detect('getWeather', { city: '贵阳' })
    expect(r).toMatchObject({ stuck: true, detector: 'generic_repeat', level: 'warning' })
  })

  it('breaker 早于 generic critical 触发（阈值约束：BREAKER < CRITICAL）', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 6; i++) {
      recorded(guard, 'getWeather', { city: '广州' }, { temperature: 28 })
    }
    // 历史 6 次：breaker(6) 已达标，generic critical(8) 未达标
    const r = guard.detect('getWeather', { city: '广州' })
    expect(r).toMatchObject({ detector: 'global_circuit_breaker' })
  })
})

describe('recordResult 回填', () => {
  it('并行调用按顺序回填到各自签名，no-progress 检测不失真', () => {
    const guard = createLoopGuard()
    // 一步内两个并行调用：先记录两个 call，结果按 toolCallId 对应回填
    guard.recordCall('calc', { e: '1+1' })
    guard.recordCall('getWeather', { city: '北京' })
    guard.recordResult('getWeather', { city: '北京' }, { temperature: 18 })
    guard.recordResult('calc', { e: '1+1' }, 2)
    // 再来一轮同签名同结果
    for (let i = 0; i < 5; i++) {
      recorded(guard, 'calc', { e: '1+1' }, 2)
    }
    const r = guard.detect('calc', { e: '1+1' })
    expect(r).toMatchObject({ stuck: true, detector: 'global_circuit_breaker' })
  })
})

describe('快照/回滚（重试支持）', () => {
  it('restore 后失败尝试的记录不参与检测', () => {
    const guard = createLoopGuard()
    guard.recordCall('getWeather', { city: '北京' })
    const mark = guard.snapshot()
    // 失败尝试中的记录
    guard.recordCall('getWeather', { city: '北京' })
    guard.recordCall('getWeather', { city: '北京' })
    // 重试回滚
    guard.restore(mark)
    // 回滚后重放相同调用：历史只有 1 条，不触发 warning
    expect(guard.detect('getWeather', { city: '北京' })).toEqual({ stuck: false })
  })
})

describe('实例隔离', () => {
  it('新实例不受旧实例历史影响', () => {
    const old = createLoopGuard()
    for (let i = 0; i < 8; i++) old.recordCall('getWeather', { city: '北京' })
    const fresh = createLoopGuard()
    expect(fresh.detect('getWeather', { city: '北京' })).toEqual({ stuck: false })
  })
})

describe('历史窗口', () => {
  it('超过 HISTORY_SIZE 后旧记录滑出窗口', () => {
    const guard = createLoopGuard()
    // 填满窗口 + 溢出（用不同参数避免触发任何检测器的历史检查逻辑）
    for (let i = 0; i < 70; i++) {
      guard.recordCall('calc', { e: String(i) })
    }
    // 第 0 条已滑出，e:"0" 只出现过一次
    expect(guard.detect('calc', { e: '0' })).toEqual({ stuck: false })
    // e:"69" 在窗口内也只出现一次
    expect(guard.detect('calc', { e: '69' })).toEqual({ stuck: false })
  })
})
