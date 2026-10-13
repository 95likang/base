import { describe, expect, it } from 'vitest'
import { type ToolDefinition, ToolRegistry, truncateResult } from './tool-registry'

/**
 * 通过 toAISDKFormat() 暴露的 execute 包装间接测试锁与截断，
 * 不直接测私有锁方法——锁的正确性由并发行为测试覆盖。
 */

/** 造一个可控制执行时长的工具 */
function makeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: 'test',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
    ...overrides,
  }
}

/** 把 ToolSet 拍平成只含 execute 的形状，便于测试调用 */
type ExecutableTool = {
  execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>
}
function asExecutables(tools: unknown): Record<string, ExecutableTool> {
  return tools as Record<string, ExecutableTool>
}

describe('注册层', () => {
  it('register/get/getAll 基本目录操作', () => {
    const registry = new ToolRegistry()
    const a = makeTool({ name: 'a' })
    const b = makeTool({ name: 'b' })
    registry.register(a, b)
    expect(registry.get('a')).toBe(a)
    expect(registry.get('nope')).toBeUndefined()
    expect(registry.getAll()).toEqual([a, b])
  })
})

describe('执行层：锁协调', () => {
  it('并发安全工具可同时执行（共享锁）', async () => {
    const registry = new ToolRegistry()
    let inflight = 0
    let maxInflight = 0
    const slow = makeTool({
      name: 'slow',
      isConcurrencySafe: true,
      execute: async () => {
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        await new Promise((r) => setTimeout(r, 20))
        inflight--
        return 'done'
      },
    })
    registry.register(slow)
    const tools = asExecutables(registry.toAISDKFormat())
    await Promise.all([tools.slow.execute({}), tools.slow.execute({}), tools.slow.execute({})])
    expect(maxInflight).toBe(3)
  })

  it('非并发安全工具独占执行（独占锁串行）', async () => {
    const registry = new ToolRegistry()
    const order: string[] = []
    const exclusive = makeTool({
      name: 'exclusive',
      isConcurrencySafe: false,
      execute: async () => {
        order.push('start')
        await new Promise((r) => setTimeout(r, 20))
        order.push('end')
        return 'done'
      },
    })
    registry.register(exclusive)
    const tools = asExecutables(registry.toAISDKFormat())
    await Promise.all([tools.exclusive.execute({}), tools.exclusive.execute({})])
    // 严格串行：start end start end
    expect(order).toEqual(['start', 'end', 'start', 'end'])
  })

  it('非并发安全工具等待并发安全工具完成后再执行', async () => {
    const registry = new ToolRegistry()
    const order: string[] = []
    const shared = makeTool({
      name: 'shared',
      isConcurrencySafe: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30))
        order.push('shared-done')
        return 'done'
      },
    })
    const exclusive = makeTool({
      name: 'exclusive',
      execute: async () => {
        order.push('exclusive-start')
        return 'done'
      },
    })
    registry.register(shared, exclusive)
    const tools = asExecutables(registry.toAISDKFormat())
    // 共享锁先进入且慢，独占锁必须等它退出后才能开始
    await Promise.all([tools.shared.execute({}), tools.exclusive.execute({})])
    expect(order).toEqual(['shared-done', 'exclusive-start'])
  })

  it('execute 抛异常也释放锁（不死锁）', async () => {
    const registry = new ToolRegistry()
    const boom = makeTool({
      name: 'boom',
      execute: async () => {
        throw new Error('boom')
      },
    })
    registry.register(boom)
    const tools = asExecutables(registry.toAISDKFormat())
    await expect(tools.boom.execute({})).rejects.toThrow('boom')
    // 锁已释放：后续调用能正常进入并完成
    await expect(tools.boom.execute({})).rejects.toThrow('boom')
  })

  it('abortSignal 透传给 execute', async () => {
    const registry = new ToolRegistry()
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const spy = makeTool({
      name: 'spy',
      execute: async (_input, options) => {
        received = options.abortSignal
        return 'done'
      },
    })
    registry.register(spy)
    const tools = asExecutables(registry.toAISDKFormat())
    await tools.spy.execute({}, { abortSignal: controller.signal })
    expect(received).toBe(controller.signal)
  })
})

describe('截断层', () => {
  it('结果对象序列化为 JSON 字符串', async () => {
    const registry = new ToolRegistry()
    registry.register(makeTool({ name: 't', execute: async () => ({ a: 1 }) }))
    const tools = asExecutables(registry.toAISDKFormat())
    const out = await tools.t.execute({})
    expect(out).toBe(JSON.stringify({ a: 1 }, null, 2))
  })

  it('超长结果头尾保留、中间省略', () => {
    const text = 'A'.repeat(600)
    const result = truncateResult(text, 100)
    expect(result.length).toBeLessThan(600)
    expect(result).toContain('[省略 ')
    expect(result.startsWith('A'.repeat(60))).toBe(true)
    expect(result.endsWith('A'.repeat(40))).toBe(true)
  })

  it('未超长不截断', () => {
    expect(truncateResult('short', 100)).toBe('short')
  })

  it('maxResultChars 为 0 时使用默认上限', () => {
    // 3000 以内不截断
    expect(truncateResult('x'.repeat(3000), 0)).toBe('x'.repeat(3000))
  })
})
