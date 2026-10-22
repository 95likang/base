import {
  deleteMemory,
  getMemory,
  lintMemories,
  listActiveMemories,
  type MemoryType,
  saveMemory,
  searchMemories,
} from '../memory/store'
import type { ToolDefinition } from './registry'

/**
 * 记忆管理工具：save / list / search / read / delete / lint 六个 action。
 * 触发规则（四类型的"什么时候该存"）全部写进 description——
 * LLM 区分记忆类型完全靠这里引导。
 */
export function createMemoryTool(): ToolDefinition {
  const today = new Date().toISOString().slice(0, 10)

  return {
    name: 'memory',
    description: [
      `管理跨会话的持久记忆。今天是 ${today}。`,
      '',
      '什么时候该 save（按类型判断）：',
      '- user（用户画像）：用户透露角色、偏好、技术背景、工作习惯。如"用户是后端工程师，Go 十年但第一次碰 React"。',
      '- feedback（行为反馈）：用户纠正你的行为，以及后续确认某做法正确。两者都要存——只存纠正会让你越来越保守。如"不要在测试里 mock 数据库"、"拆成多个小 PR 更好（已确认）"。',
      '- project（项目动态）：进行中的工作、决策、截止日期。衰减最快，必须填 expiresAt，且相对日期要换算成绝对日期——"下周四"存成具体日期，一个月后才能看懂。',
      '- reference（外部资源）：用户指出的外部信息渠道。如"bug 跟踪在 Github 看板 xxx 栏目"、"oncall 看 Grafana 的 api-latency 面板"。',
      '',
      '不该存的：一次性的任务细节、代码片段本身、可从文件/工具直接获得的信息。',
      '同名记忆会覆盖更新——发现已有记忆过时或表述需修订时，用相同 name 重新 save。',
      '系统提示里已有全部记忆的索引（[id] name — description），read 前先看索引。',
      'lint 会对记忆库做体检（引用路径失效、长期未读、同名重复）；发现过时记忆时先 lint 再决定 delete 或重存。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'search', 'read', 'delete', 'lint'],
          description: 'save 保存 | list 列表 | search 搜索 | read 读取 | delete 删除 | lint 体检',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: '记忆类型（save 时必填）',
        },
        name: {
          type: 'string',
          description: '记忆名称，简短唯一，如"用户偏好 TypeScript"（save 时必填）',
        },
        description: { type: 'string', description: '一句话描述（save 时必填）' },
        content: { type: 'string', description: '记忆完整内容（save 时必填）' },
        expiresAt: {
          type: 'string',
          description: '过期日期 YYYY-MM-DD（仅 project 类型必填，如 2026-05-07；其他类型不填）',
        },
        query: { type: 'string', description: '搜索关键词（search 时必填）' },
        id: {
          type: 'string',
          description: '记忆 id（read/delete 时必填，来自系统提示的索引或 list 结果）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    maxResultChars: 2000,
    // biome-ignore lint/suspicious/noExplicitAny: 入参来自 LLM、按 parameters 的 JSON Schema 动态校验，无静态类型
    execute: async (args: any) => {
      switch (args.action) {
        case 'save': {
          if (!args.name || !args.type || !args.content) {
            return '保存失败：需要 name、type、content 参数'
          }
          if (!['user', 'feedback', 'project', 'reference'].includes(args.type)) {
            return `保存失败：未知类型 ${args.type}`
          }
          if (args.type === 'project' && !args.expiresAt) {
            return '保存失败：project 类型必须填 expiresAt（相对日期换算成绝对日期 YYYY-MM-DD）'
          }
          let expiresAt: Date | null = null
          if (args.expiresAt) {
            expiresAt = new Date(`${args.expiresAt}T23:59:59Z`)
            if (Number.isNaN(expiresAt.getTime())) {
              return `保存失败：expiresAt "${args.expiresAt}" 不是有效的 YYYY-MM-DD 日期`
            }
          }
          const saved = await saveMemory({
            type: args.type as MemoryType,
            name: args.name,
            description: args.description || args.name,
            content: args.content,
            expiresAt,
          })
          return `已保存记忆: [${saved.id}] ${saved.name}`
        }
        case 'list': {
          const entries = await listActiveMemories()
          if (entries.length === 0) return '当前没有存储任何记忆。'
          return `记忆列表（共 ${entries.length} 条）：\n${entries
            .map((e) => `  [${e.id}] (${e.type}) ${e.name} — ${e.description}`)
            .join('\n')}`
        }
        case 'search': {
          if (!args.query) return '搜索失败：需要 query 参数'
          const results = await searchMemories(args.query)
          if (results.length === 0) return `没有找到与 "${args.query}" 相关的记忆。`
          return `搜索结果（${results.length} 条匹配）：\n${results
            .map((e) => `  [${e.id}] (${e.type}) ${e.name} — ${e.description}`)
            .join('\n')}`
        }
        case 'read': {
          if (!args.id) return '读取失败：需要 id 参数'
          const entry = await getMemory(args.id)
          if (!entry) return `记忆不存在或已过期: ${args.id}`
          return `[${entry.id}] (${entry.type}) ${entry.name}\n${entry.content}`
        }
        case 'delete': {
          if (!args.id) return '删除失败：需要 id 参数'
          return (await deleteMemory(args.id)) ? `已删除记忆: ${args.id}` : `记忆不存在: ${args.id}`
        }
        case 'lint': {
          const { total, reports } = await lintMemories()
          if (reports.length === 0) return `记忆体检：共 ${total} 条，未发现问题。`
          const details = reports.map(
            (r) =>
              `  [${r.entry.id}] (${r.entry.type}) ${r.entry.name}\n${r.issues
                .map((i) => `     • ${i.kind}: ${i.message}`)
                .join('\n')}`,
          )
          return `记忆体检：共 ${total} 条，${reports.length} 条有警告\n${details.join('\n')}`
        }
        default:
          return `未知操作: ${args.action}`
      }
    },
  }
}
