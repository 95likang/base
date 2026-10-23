import type { ToolDefinition } from '../tools/registry'

/** 插件配置：只支持标量；字符串可写成 `${ENV_KEY}` 从环境变量取值 */
export interface PluginConfig {
  [key: string]: string | number | boolean
}

/** 传给插件 activate 的受限 API：只能注册工具、读配置、写日志 */
export interface PluginApi {
  /** 注册工具；实际名称会被加上 `<插件名>__` 前缀，避免跨插件冲突 */
  registerTools(tools: ToolDefinition[]): void
  /** 解析环境变量占位符后的最终配置 */
  getConfig(): PluginConfig
  log(message: string): void
}

/**
 * 插件定义 —— 能力与核心的分离点。
 * 插件作者只实现 activate：拿到 PluginApi 后注册工具、建立连接；
 * 进程退出或管理页卸载时调用 destroy 释放资源。
 */
export interface PluginDefinition {
  name: string
  version: string
  description: string
  config?: PluginConfig

  activate(api: PluginApi): Promise<void> | void
  destroy?(): Promise<void> | void
}
