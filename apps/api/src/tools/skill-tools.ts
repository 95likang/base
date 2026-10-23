import type { SkillLoader } from '../skills/loader'
import type { ToolDefinition } from './registry'

/**
 * Skill 加载工具：系统提示只给可用 skills 索引（省上下文），
 * 模型决定使用某个 skill 时用本工具取回完整指令，正文随工具结果进入对话历史。
 */
export function createSkillTool(loader: SkillLoader): ToolDefinition {
  return {
    name: 'skill',
    description: [
      '加载 Skill 的完整指令。',
      '决定执行系统提示中列出的某个 Skill 时，先调用本工具取回完整指令，再严格按指令执行。',
      '加载结果已进入本次对话上下文，同一个 Skill 不需要重复加载。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称（来自系统提示的可用 Skills 列表）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    // skill 正文通常较长，默认 3000 会截断执行步骤
    maxResultChars: 8000,
    execute: async ({ name }: { name: string }) => {
      const skill = loader.get(name)
      if (!skill) {
        const available = loader
          .list()
          .map((s) => s.name)
          .join(', ')
        return `找不到 skill: ${name}（可用: ${available || '无'}）`
      }
      return skill.content
    },
  }
}
