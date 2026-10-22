import type { ToolDefinition, ToolRegistry } from './registry'

/**
 * 延迟工具的发现入口：激活后 registry 原地更新 ToolSet，后续步骤立即可用。
 * 依赖请求级 registry 实例，因此以工厂函数形式创建。
 */
export function createToolSearchTool(registry: ToolRegistry): ToolDefinition {
  return {
    name: 'tool_search',
    description:
      '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），激活后即可直接调用',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query }: { query: string }) => {
      const results = registry.searchTools(query)
      if (results.length === 0) return `没有找到匹配 "${query}" 的工具`
      return results.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))
    },
  }
}
