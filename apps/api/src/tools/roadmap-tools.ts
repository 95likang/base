import { toJsonSchemaParameters } from '../genui/spec'
import {
  areSessionTimesValid,
  isDateRangeValid,
  PRACTICE_ROADMAP_TOOL_NAME,
  roadmapToolSchema,
} from '../roadmap/spec'
import { createRoadmap } from '../roadmap/store'
import type { ToolDefinition } from './registry'

/**
 * practice_roadmap：把已确认的训练方案展开成两级路线图并落库。
 *
 * renderOnly 在这里被借用为「本步结束后直接收尾」：写库成功后卡片由前端渲染，
 * 不需要再跑一轮模型让它复述整张路线图（那会把同样的内容按 token 再付一次钱）。
 * 注意这与 genui 的纯渲染工具不同——execute 有副作用，失败必须 throw，
 * 由 loop 转发 tool-output-error 并继续一轮让模型处理。
 */
export function createRoadmapTool(options: { chatId: string; userId: string }): ToolDefinition {
  return {
    name: PRACTICE_ROADMAP_TOOL_NAME,
    description: [
      '生成并保存训练路线图（两级：阶段 → 阶段内每次训练），前端会直接渲染成卡片。',
      '',
      '什么时候调用：practice-coach 走完 Step 6、用户已经逐项确认方案（整体目标、概述、总体时间、开始/结束日期、每周训练次数、每次训练时长）并选定本阶段单点之后。方案未确认时不要调用。',
      '内容必须来自与用户确认过的方案，不得为了填满结构编造子技能、判据或产物。',
      '',
      '字段含义：',
      '- title / goal：这张路线图覆盖的技能与总目标。',
      '- summary / overallDuration / startDate / endDate / sessionsPerWeek / sessionMinutes：计划概述、总体时间、开始日期、结束日期、每周训练次数、每次训练时长。这些必须用用户在 Step 6 确认过的值，不得自行填写；日期格式 YYYY-MM-DD，endDate 不得早于 startDate。',
      '- currentPhaseIndex：当前激活的阶段下标（从 0 开始）。其余阶段照排但未激活——执行永远只攻当前阶段的一个单点。',
      '- phases[]：阶段。goal 是阶段目标，criteria 是通过本阶段的判据，focus 是本阶段只攻的那一个子技能。',
      '- sessions[]：阶段内的单次训练。subskill 对应哪个子技能；task 是这次具体做什么；criteria 是做到什么算成；minutes 是预计分钟数（5–180）；product 是练完手里多出来的那样东西。',
      '- sessions[].date / startTime / endTime：这次训练的具体日期与起止时段（YYYY-MM-DD、HH:MM），按计划起止日与每周次数排期，endTime 必须晚于 startTime。',
      '',
      '调用后无需在回复里复述路线图内容。',
    ].join('\n'),
    parameters: toJsonSchemaParameters(roadmapToolSchema),
    renderOnly: true,
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (input: unknown) => {
      // 工具 schema 要求计划元信息必填：provider 不保证按 JSON Schema 校验，这里再验一次
      const parsed = roadmapToolSchema.safeParse(input)
      if (!parsed.success) {
        // 失败必须 throw：前端只在 output-available 时渲染，吞错会展示一份没落库的路线图
        const issue = parsed.error.issues[0]
        const reason = issue ? `${issue.path.join('.')}: ${issue.message}` : '格式不合法'
        throw new Error(`路线图内容不合法：${reason}`)
      }
      const content = parsed.data
      if (content.currentPhaseIndex >= content.phases.length) {
        throw new Error('路线图内容不合法：currentPhaseIndex 超出 phases 范围')
      }
      if (!isDateRangeValid(content)) {
        throw new Error('路线图内容不合法：endDate 早于 startDate')
      }
      if (!areSessionTimesValid(content.phases)) {
        throw new Error('路线图内容不合法：训练结束时间必须晚于开始时间')
      }
      const row = await createRoadmap({ userId: options.userId, chatId: options.chatId, content })
      return { roadmapId: row.id }
    },
  }
}
