import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginManager } from './manager'
import type { PluginApi, PluginDefinition } from './types'

function makePlugin(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    name: 'demo',
    version: '1.0.0',
    description: '演示插件',
    activate(api: PluginApi) {
      api.registerTools([
        {
          name: 'ping',
          description: 'ping',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'pong',
        },
      ])
    },
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('PluginManager 加载', () => {
  it('工具名加插件前缀，描述带插件标记', async () => {
    const manager = new PluginManager([makePlugin()])

    const tools = await manager.load('demo')

    expect(tools).toEqual(['demo__ping'])
    expect(manager.isLoaded('demo')).toBe(true)
    const [tool] = manager.getTools()
    expect(tool?.name).toBe('demo__ping')
    expect(tool?.description).toBe('[Plugin:demo] ping')
  })

  it('解析环境变量占位符', async () => {
    vi.stubEnv('PLUGIN_TEST_TOKEN', 'from-env')
    const manager = new PluginManager([
      makePlugin({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: 配置占位符，不是模板字符串
        config: { token: '${PLUGIN_TEST_TOKEN}' },
        activate(api) {
          const config = api.getConfig()
          api.registerTools([
            {
              name: 'config',
              description: String(config.token),
              parameters: { type: 'object', properties: {} },
              execute: async () => config,
            },
          ])
        },
      }),
    ])

    await manager.load('demo')

    const [tool] = manager.getTools()
    expect(tool?.description).toBe('[Plugin:demo] from-env')
  })

  it('未知插件和重复加载都抛错', async () => {
    const manager = new PluginManager([makePlugin()])

    await expect(manager.load('nope')).rejects.toThrow('未知插件: nope')
    await manager.load('demo')
    await expect(manager.load('demo')).rejects.toThrow('已加载')
  })

  it('并发加载同一插件只执行一次 activate', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const activate = vi.fn(async () => {
      await gate
    })
    const manager = new PluginManager([makePlugin({ activate })])

    const first = manager.load('demo')
    await expect(manager.load('demo')).rejects.toThrow('正在加载')
    release()
    await expect(first).resolves.toEqual([])
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('activate 抛错时不留下已加载状态和工具', async () => {
    const manager = new PluginManager([
      makePlugin({
        activate(api) {
          api.registerTools([
            {
              name: 'half',
              description: 'half',
              parameters: { type: 'object', properties: {} },
              execute: async () => 'half',
            },
          ])
          throw new Error('boom')
        },
      }),
    ])

    await expect(manager.load('demo')).rejects.toThrow('boom')
    expect(manager.isLoaded('demo')).toBe(false)
    expect(manager.getTools()).toEqual([])
  })
})

describe('PluginManager 卸载与列表', () => {
  it('unload 调用 destroy 并移除工具；未加载时返回 false', async () => {
    const destroy = vi.fn()
    const manager = new PluginManager([makePlugin({ destroy })])

    await manager.load('demo')
    expect(await manager.unload('demo')).toBe(true)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(manager.getTools()).toEqual([])
    expect(await manager.unload('demo')).toBe(false)
  })

  it('destroy 抛错不影响卸载结果', async () => {
    const manager = new PluginManager([
      makePlugin({
        destroy() {
          throw new Error('destroy failed')
        },
      }),
    ])

    await manager.load('demo')
    expect(await manager.unload('demo')).toBe(true)
    expect(manager.isLoaded('demo')).toBe(false)
  })

  it('list 同时返回已加载与未加载插件', async () => {
    const manager = new PluginManager([
      makePlugin(),
      makePlugin({ name: 'other', version: '2.0.0', activate() {} }),
    ])

    await manager.load('demo')

    expect(manager.list()).toEqual([
      {
        name: 'demo',
        version: '1.0.0',
        description: '演示插件',
        loaded: true,
        tools: ['demo__ping'],
      },
      { name: 'other', version: '2.0.0', description: '演示插件', loaded: false, tools: [] },
    ])
  })
})
