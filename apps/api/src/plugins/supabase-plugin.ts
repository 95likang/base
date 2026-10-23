import type { PluginApi, PluginDefinition } from './types'

/** 未配置 Supabase 时返回的演示数据（与文档中的示例一致） */
const MOCK_TABLES = ['users', 'posts', 'comments', 'sessions']

const MOCK_ROWS: Record<string, Record<string, unknown>[]> = {
  users: [
    { id: 1, name: '张三', email: 'zhang@example.com', role: 'admin' },
    { id: 2, name: '李四', email: 'li@example.com', role: 'user' },
    { id: 3, name: '王五', email: 'wang@example.com', role: 'user' },
  ],
  posts: [
    { id: 1, title: 'Agent 开发入门', author_id: 1, status: 'published' },
    { id: 2, title: 'Plugin 架构设计', author_id: 1, status: 'draft' },
  ],
  comments: [{ id: 1, post_id: 1, user_id: 2, content: '写得不错！' }],
  sessions: [{ id: 'sess-001', user_id: 1, created_at: '2026-05-01T10:00:00Z' }],
}

/**
 * Supabase 示例插件：演示"能力通过插件动态接入"。
 * 配置 SUPABASE_URL / SUPABASE_KEY 时走占位分支，未配置时返回内置演示数据。
 */
export const supabasePlugin: PluginDefinition = {
  name: 'supabase',
  version: '1.0.0',
  description: '提供 Supabase 数据库操作能力（query / insert / list_tables）',
  config: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是配置占位符，由 PluginManager 解析，不是模板字符串
    supabaseUrl: '${SUPABASE_URL}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上
    supabaseKey: '${SUPABASE_KEY}',
  },

  activate(api: PluginApi) {
    const config = api.getConfig()
    const url = config.supabaseUrl as string

    if (!url) {
      api.log('未配置 SUPABASE_URL / SUPABASE_KEY，使用 Mock 模式')
    }

    api.registerTools([
      {
        name: 'list_tables',
        description: '列出数据库中所有表',
        parameters: { type: 'object', properties: {}, required: [] },
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async () => {
          if (!url) {
            return {
              tables: MOCK_TABLES,
              note: 'Mock 模式 — 配置 SUPABASE_URL 和 SUPABASE_KEY 连接真实数据库',
            }
          }
          return `连接 ${url} 查询表列表...（真实实现会调用 Supabase API）`
        },
      },
      {
        name: 'query',
        description: '查询指定表的数据，支持 select / where / limit',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: '表名' },
            select: { type: 'string', description: '查询字段，默认 *' },
            where: { type: 'string', description: '过滤条件，如 status=active' },
            limit: { type: 'number', description: '返回条数限制，默认 10' },
          },
          required: ['table'],
        },
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async (input: {
          table: string
          select?: string
          where?: string
          limit?: number
        }) => {
          const { table, select = '*', where, limit = 10 } = input
          if (!url) {
            const rows = MOCK_ROWS[table] ?? []
            const filtered = where ? rows.filter((row) => matchesWhere(row, where)) : rows
            return { table, rows: filtered.slice(0, limit), total: filtered.length }
          }
          return `SELECT ${select} FROM ${table}${where ? ` WHERE ${where}` : ''} LIMIT ${limit}`
        },
      },
      {
        name: 'insert',
        description: '向指定表插入一条记录',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: '表名' },
            data: { type: 'object', description: '要插入的数据' },
          },
          required: ['table', 'data'],
        },
        execute: async (input: { table: string; data: Record<string, unknown> }) => {
          const { table, data } = input
          if (!url) {
            return {
              success: true,
              table,
              inserted: { id: Math.floor(Math.random() * 1000), ...data },
              note: 'Mock 模式',
            }
          }
          return `INSERT INTO ${table} — ${JSON.stringify(data)}`
        },
      },
    ])

    api.log('已注册 3 个工具（list_tables / query / insert）')
  },

  destroy() {
    console.log('  [plugin:supabase] 连接已释放')
  },
}

/** 解析 `field=value` 形式的过滤条件；格式不合法时不过滤任何行 */
function matchesWhere(row: Record<string, unknown>, where: string): boolean {
  const [field, value] = where.split('=')
  if (!field || value === undefined) return false
  return String(row[field]) === value
}
