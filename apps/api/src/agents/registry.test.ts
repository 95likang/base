import { describe, expect, it } from 'vitest'
import { SubAgentRegistry } from './registry'
import type { SubAgentRun } from './types'

function makeRun(registry: SubAgentRegistry): SubAgentRun {
  return {
    id: registry.generateId(),
    task: 'test task',
    status: 'running',
    depth: 1,
    startedAt: new Date().toISOString(),
  }
}

describe('SubAgentRegistry', () => {
  it('深度达到上限时拒绝派发', () => {
    const registry = new SubAgentRegistry({ maxSpawnDepth: 1 })
    expect(registry.checkDepth(0).ok).toBe(true)
    const denied = registry.checkDepth(1)
    expect(denied.ok).toBe(false)
    expect(denied.reason).toContain('最大嵌套深度')
  })

  it('并发已满时排队等待，槽位释放后继续执行', async () => {
    const registry = new SubAgentRegistry({ maxConcurrent: 1 })
    expect(await registry.acquireSlot()).toBe(true)
    const first = makeRun(registry)
    registry.register(first)

    let secondAcquired = false
    const waiting = registry.acquireSlot().then((ok) => {
      secondAcquired = ok
      return ok
    })
    await Promise.resolve()
    expect(secondAcquired).toBe(false)

    registry.complete(first.id, 'done')
    await expect(waiting).resolves.toBe(true)
  })

  it('排队期间取消会放弃槽位', async () => {
    const registry = new SubAgentRegistry({ maxConcurrent: 1 })
    expect(await registry.acquireSlot()).toBe(true)

    const controller = new AbortController()
    const waiting = registry.acquireSlot(controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBe(false)
  })

  it('重复 complete 不会重复释放槽位', async () => {
    const registry = new SubAgentRegistry({ maxConcurrent: 1 })
    expect(await registry.acquireSlot()).toBe(true)
    const run = makeRun(registry)
    registry.register(run)
    registry.complete(run.id, 'done')
    registry.complete(run.id, 'done')

    expect(await registry.acquireSlot()).toBe(true)
    let got = false
    registry.acquireSlot().then((ok) => {
      got = ok
    })
    await Promise.resolve()
    expect(got).toBe(false)
  })

  it('complete / fail 更新状态与结束时间', () => {
    const registry = new SubAgentRegistry()
    const ok = makeRun(registry)
    const failed = makeRun(registry)
    const timedOut = makeRun(registry)
    registry.register(ok)
    registry.register(failed)
    registry.register(timedOut)

    registry.complete(ok.id, 'result')
    registry.fail(failed.id, 'boom')
    registry.fail(timedOut.id, 'timeout', 'timeout')

    const find = (id: string) => registry.getAllRuns().find((run) => run.id === id)
    expect(find(ok.id)).toMatchObject({ status: 'completed', result: 'result' })
    expect(find(failed.id)).toMatchObject({ status: 'error', error: 'boom' })
    expect(find(timedOut.id)).toMatchObject({ status: 'timeout', error: 'timeout' })
    expect(find(ok.id)?.finishedAt).toBeTruthy()
    expect(registry.getActiveRuns()).toHaveLength(0)
  })

  it('超出保留上限时淘汰最旧的已结束记录，运行中的保留', () => {
    const registry = new SubAgentRegistry()
    const running = makeRun(registry)
    registry.register(running)
    for (let i = 0; i < 250; i++) {
      const run = makeRun(registry)
      registry.register(run)
      registry.complete(run.id, 'done')
    }

    const runs = registry.getAllRuns()
    expect(runs).toHaveLength(200)
    expect(runs.some((run) => run.id === running.id)).toBe(true)
  })
})
