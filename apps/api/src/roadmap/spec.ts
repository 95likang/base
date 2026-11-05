import { z } from 'zod'

/**
 * 训练路线图的内容规格。
 *
 * 服务端（工具 schema / 落库前校验）与前端（渲染前校验）共用这一份定义：
 * 模型输出等于外部输入，前端只能使用 parseRoadmapContent 重建后的对象，
 * 不允许把 part.input 直接透传给组件。
 *
 * 两份 schema 的分工：
 * - roadmapContentSchema：读取用，四个计划元信息可选，兼容旧版工具生成的记录
 * - roadmapToolSchema：工具参数用，四个元信息必填，保证新计划完整
 *
 * 本文件必须保持纯 zod、无 node/db 依赖——它会被打进浏览器 bundle。
 */

/** 标签长度上限：模型输出不可信，所有上限写在 schema 里而不是 description 里 */
const shortText = z.string().min(1).max(40)
const midText = z.string().min(1).max(200)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:MM')

const sessionSchema = z.object({
  /** 这次训练攻的子技能，对应方案里的子技能名 */
  subskill: shortText,
  /** 这次坐下来具体做什么 */
  task: z.string().min(1).max(300),
  /** 做到什么算成，两个人都能判 */
  criteria: midText,
  /** 本轮预计分钟数 */
  minutes: z.number().int().min(5).max(180),
  /** 这次练完手里多出来的那样东西 */
  product: z.string().min(1).max(120),
  /** 具体日期与起止时段；读取时可选，工具参数里必填 */
  date: isoDate.optional(),
  startTime: hhmm.optional(),
  endTime: hhmm.optional(),
  /** 完成状态：由「计划详情」页提交，模型生成时不填 */
  status: z.literal('done').optional(),
  completionNote: z.string().min(1).max(1000).optional(),
  feedback: z.string().min(1).max(1000).optional(),
  completedAt: z.string().max(40).optional(),
})

const phaseSchema = z.object({
  title: shortText,
  /** 阶段目标 */
  goal: midText,
  /** 通过本阶段的判据 */
  criteria: midText,
  /** 本阶段只攻的那一个子技能 */
  focus: z.string().min(1).max(100),
  sessions: z.array(sessionSchema).min(1).max(8),
})

export const roadmapContentSchema = z.object({
  title: z.string().min(1).max(60),
  /** 整张路线图对应的技能目标 */
  goal: midText,
  /**
   * 计划概述：解决什么、阶段怎么排。
   * 以下四项在读取时可选：旧版工具生成的记录没有这些字段，放宽后仍能展示；
   * 新计划由 roadmapToolSchema（必填）保证完整。
   */
  summary: z.string().min(1).max(300).optional(),
  /** 总体时间，如「8 周」 */
  overallDuration: z.string().min(1).max(40).optional(),
  /** 计划开始 / 结束日期（YYYY-MM-DD） */
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  /** 每周训练次数 */
  sessionsPerWeek: z.number().int().min(1).max(14).optional(),
  /** 每次训练时长（分钟） */
  sessionMinutes: z.number().int().min(10).max(180).optional(),
  /** 当前激活的阶段下标：其余阶段照排但未激活 */
  currentPhaseIndex: z.number().int().min(0).max(4),
  phases: z.array(phaseSchema).min(1).max(5),
})

/** 工具参数的训练条目：具体日期与起止时段必填 */
const sessionToolSchema = sessionSchema.required({
  date: true,
  startTime: true,
  endTime: true,
})

const phaseToolSchema = phaseSchema.extend({
  sessions: z.array(sessionToolSchema).min(1).max(8),
})

/** 工具参数：计划与训练的时间信息必填，避免模型跳过与用户的确认直接生成 */
export const roadmapToolSchema = roadmapContentSchema
  .extend({ phases: z.array(phaseToolSchema).min(1).max(5) })
  .required({
    summary: true,
    overallDuration: true,
    startDate: true,
    endDate: true,
    sessionsPerWeek: true,
    sessionMinutes: true,
  })

export type RoadmapContent = z.infer<typeof roadmapContentSchema>

/** 工具名与前端 part 前缀共用一份，避免两处字符串漂移 */
export const PRACTICE_ROADMAP_TOOL_NAME = 'practice_roadmap'

/** 跨字段约束：日期区间必须有序（YYYY-MM-DD 字符串可直接比较） */
export function isDateRangeValid(data: { startDate?: string; endDate?: string }): boolean {
  if (!data.startDate || !data.endDate) return true
  return data.endDate >= data.startDate
}

/** 跨字段约束：每次训练的结束时段必须晚于开始时段（HH:MM 字符串可直接比较） */
export function areSessionTimesValid(
  phases: Array<{ sessions: Array<{ startTime?: string; endTime?: string }> }>,
): boolean {
  return phases.every((phase) =>
    phase.sessions.every((session) => {
      if (!session.startTime || !session.endTime) return true
      return session.endTime > session.startTime
    }),
  )
}

/**
 * 校验并重建路线图内容。
 *
 * schema 本身能被 z.toJSONSchema 完整表达（故不使用 refine），
 * 「currentPhaseIndex 落在 phases 范围内」「endDate 不早于 startDate」
 * 这两条跨字段约束在这里补。
 * 失败返回 null，调用方显式降级，不要回退到 part.input。
 */
export function parseRoadmapContent(input: unknown): RoadmapContent | null {
  const parsed = roadmapContentSchema.safeParse(input)
  if (!parsed.success) return null
  if (parsed.data.currentPhaseIndex >= parsed.data.phases.length) return null
  if (!isDateRangeValid(parsed.data)) return null
  if (!areSessionTimesValid(parsed.data.phases)) return null
  return parsed.data
}
