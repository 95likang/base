import { Hono } from 'hono'
import { ApiError } from '../lib/api-error'
import { pluginManager } from '../plugins'

/**
 * 插件管理路由（admin 管理页的数据源）。
 * GET  /               全部插件 + 加载状态 + 已注册工具
 * POST /:name/load     加载插件（启动时已自动加载，这里用于重新加载卸载过的插件）
 * POST /:name/unload   卸载插件并释放其资源
 *
 * 加载状态只存在于当前进程：重启后回到启动时的自动加载状态。
 */
export const pluginsRoute = new Hono()
  .get('/', (c) => {
    return c.json({ plugins: pluginManager.list() })
  })
  .post('/:name/load', async (c) => {
    const name = c.req.param('name')
    if (!pluginManager.has(name)) {
      throw new ApiError('PLUGIN_NOT_FOUND', `找不到插件: ${name}`, 404)
    }
    if (pluginManager.isLoaded(name)) {
      throw new ApiError('PLUGIN_ALREADY_LOADED', `插件 ${name} 已加载`, 409)
    }

    try {
      const tools = await pluginManager.load(name)
      return c.json({ tools })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ApiError('PLUGIN_ACTIVATE_FAILED', `加载 ${name} 失败: ${message}`, 500)
    }
  })
  .post('/:name/unload', async (c) => {
    const name = c.req.param('name')
    if (!(await pluginManager.unload(name))) {
      throw new ApiError('PLUGIN_NOT_LOADED', `插件 ${name} 未加载`, 404)
    }
    return c.json({ ok: true })
  })
