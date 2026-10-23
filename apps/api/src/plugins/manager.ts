import type { ToolDefinition } from '../tools/registry'
import type { PluginApi, PluginConfig, PluginDefinition } from './types'

interface PluginSummary {
  name: string
  version: string
  description: string
  /** 当前进程内是否已加载（重启后回到启动时的自动加载状态） */
  loaded: boolean
  /** 已注册的工具名（带 `<插件名>__` 前缀） */
  tools: string[]
}

interface LoadedPlugin {
  definition: PluginDefinition
  tools: ToolDefinition[]
}

/** 匹配整个字符串都是 `${ENV_KEY}` 的配置值 */
const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/**
 * 插件管理器 —— 持有插件的进程级状态：哪些插件可用、哪些已加载、各自注册了哪些工具。
 *
 * ToolRegistry 是请求级的（锁状态不跨请求），所以这里不持有 registry：
 * 每个对话请求通过 getTools() 取走已加载插件的工具，注入自己的 registry。
 * 加载/卸载只影响之后的请求，进行中的请求保持已拿到的工具集。
 */
export class PluginManager {
  private readonly available: Map<string, PluginDefinition>
  private readonly loaded = new Map<string, LoadedPlugin>()
  /** 正在 activate 的插件：挡住并发加载，避免 activate 被执行两次 */
  private readonly loading = new Set<string>()

  constructor(definitions: PluginDefinition[]) {
    this.available = new Map(definitions.map((definition) => [definition.name, definition]))
  }

  has(name: string): boolean {
    return this.available.has(name)
  }

  /** 已加载或正在加载（路由据此返回 409，避免重复 activate） */
  isLoaded(name: string): boolean {
    return this.loaded.has(name) || this.loading.has(name)
  }

  /** 激活插件并收集其注册的工具；activate 抛错时不留下任何已加载状态 */
  async load(name: string): Promise<string[]> {
    const definition = this.available.get(name)
    if (!definition) throw new Error(`未知插件: ${name}`)
    if (this.loaded.has(name)) throw new Error(`插件 "${name}" 已加载`)
    if (this.loading.has(name)) throw new Error(`插件 "${name}" 正在加载`)

    const config = this.resolveEnvVars(definition.config ?? {})
    const tools: ToolDefinition[] = []

    const api: PluginApi = {
      registerTools: (definitions) => {
        for (const tool of definitions) {
          tools.push({
            ...tool,
            name: `${name}__${tool.name}`,
            description: `[Plugin:${name}] ${tool.description}`,
          })
        }
      },
      getConfig: () => config,
      log: (message) => console.log(`  [plugin:${name}] ${message}`),
    }

    this.loading.add(name)
    try {
      await definition.activate(api)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  [plugin:${name}] 激活失败: ${message}`)
      throw err
    } finally {
      this.loading.delete(name)
    }

    this.loaded.set(name, { definition, tools })
    return tools.map((tool) => tool.name)
  }

  /** 卸载插件：先 destroy 释放资源，再丢弃其工具（返回 false 表示未加载） */
  async unload(name: string): Promise<boolean> {
    const plugin = this.loaded.get(name)
    if (!plugin) return false

    if (plugin.definition.destroy) {
      try {
        await plugin.definition.destroy()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`  [plugin:${name}] destroy 出错: ${message}`)
      }
    }

    this.loaded.delete(name)
    return true
  }

  /** 全部已加载插件的工具，供每个对话请求注入自己的 ToolRegistry */
  getTools(): ToolDefinition[] {
    return Array.from(this.loaded.values()).flatMap((plugin) => plugin.tools)
  }

  /** 管理页数据源：可用插件 + 加载状态 + 已注册工具 */
  list(): PluginSummary[] {
    return Array.from(this.available.values()).map((definition) => {
      const plugin = this.loaded.get(definition.name)
      return {
        name: definition.name,
        version: definition.version,
        description: definition.description,
        loaded: plugin !== undefined,
        tools: plugin?.tools.map((tool) => tool.name) ?? [],
      }
    })
  }

  /** 把配置里的 `${ENV_KEY}` 占位符替换为环境变量值（未设置时为空串） */
  private resolveEnvVars(config: PluginConfig): PluginConfig {
    const resolved: PluginConfig = {}
    for (const [key, value] of Object.entries(config)) {
      const match = typeof value === 'string' ? ENV_PLACEHOLDER.exec(value) : null
      resolved[key] = match ? (process.env[match[1] as string] ?? '') : value
    }
    return resolved
  }
}
