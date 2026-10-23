import { PluginManager } from './manager'
import { supabasePlugin } from './supabase-plugin'
import type { PluginDefinition } from './types'

/**
 * 可加载的插件清单：新增插件只需实现 PluginDefinition 并加到这里。
 * 所有插件在 API 启动时自动加载（见 src/index.ts），运行期可在管理页卸载/重载。
 */
const availablePlugins: PluginDefinition[] = [supabasePlugin]

/** 进程级单例：对话请求从 getTools() 取工具，管理页读写加载状态 */
export const pluginManager = new PluginManager(availablePlugins)
