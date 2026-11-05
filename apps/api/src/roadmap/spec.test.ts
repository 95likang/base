import { describe, expect, it } from 'vitest'
import { parseRoadmapContent, roadmapContentSchema, roadmapToolSchema } from './spec'

/** 合法的两级路线图：三个阶段，当前激活第二个 */
function validRoadmap() {
  return {
    title: 'React 实战训练',
    goal: '给一个陌生需求，独立拆出组件边界并写出可复用的实现',
    summary: '从组件基础到性能优化，三个阶段逐步推进',
    overallDuration: '8 周',
    startDate: '2026-11-05',
    endDate: '2027-01-05',
    sessionsPerWeek: 3,
    sessionMinutes: 45,
    currentPhaseIndex: 1,
    phases: [
      {
        title: '组件基础',
        goal: '能独立写出受控表单',
        criteria: '不看文档写出一个带校验的受控表单',
        focus: '状态提升',
        sessions: [
          {
            subskill: '状态提升',
            task: '把三个子组件的输入状态提升到父组件',
            criteria: '父组件持有全部状态，子组件无 useState',
            minutes: 40,
            product: '一份可运行的受控表单',
            date: '2026-11-05',
            startTime: '20:00',
            endTime: '20:40',
          },
        ],
      },
      {
        title: '组件边界',
        goal: '能按职责拆分组件',
        criteria: '给出的设计稿能拆出 5 个以内组件并说清边界',
        focus: '组件拆分',
        sessions: [
          {
            subskill: '组件拆分',
            task: '找一个现成页面，拆出组件树并标注数据流向',
            criteria: '拆出的组件树能让另一个人照着实现',
            minutes: 60,
            product: '一份组件树草稿',
            date: '2026-11-08',
            startTime: '10:00',
            endTime: '11:00',
          },
        ],
      },
      {
        title: '性能',
        goal: '能定位无谓重渲染',
        criteria: '给一个慢页面，10 分钟内定位到重渲染根因',
        focus: '渲染优化',
        sessions: [
          {
            subskill: '渲染优化',
            task: '用 Profiler 录一次交互，标出重复渲染的组件',
            criteria: '能说出每一个重复渲染的原因',
            minutes: 45,
            product: '一份 Profiler 截图与结论',
            date: '2026-11-12',
            startTime: '20:00',
            endTime: '20:45',
          },
        ],
      },
    ],
  }
}

describe('训练路线图规格', () => {
  it('合法输入通过，并生成新对象', () => {
    const input = validRoadmap()
    const content = parseRoadmapContent(input)
    expect(content).not.toBeNull()
    expect(content).not.toBe(input)
    expect(content?.phases).toHaveLength(3)
  })

  it('未声明字段被剥离', () => {
    const content = parseRoadmapContent({ ...validRoadmap(), injected: 'x' })
    expect(content).not.toBeNull()
    expect(content).not.toHaveProperty('injected')
  })

  it('currentPhaseIndex 超出 phases 范围时判为不合法', () => {
    const input = validRoadmap()
    input.currentPhaseIndex = 3
    expect(parseRoadmapContent(input)).toBeNull()
  })

  it('phases 超过 5 个不合法', () => {
    const input = validRoadmap()
    const phase = input.phases[0]
    input.phases = Array.from({ length: 6 }, () => phase)
    const result = roadmapContentSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('单个阶段超过 8 次训练不合法', () => {
    const input = validRoadmap()
    const session = input.phases[0].sessions[0]
    input.phases[0].sessions = Array.from({ length: 9 }, () => session)
    expect(parseRoadmapContent(input)).toBeNull()
  })

  it('minutes 越界不合法', () => {
    const input = validRoadmap()
    input.phases[0].sessions[0].minutes = 500
    expect(parseRoadmapContent(input)).toBeNull()
  })

  it('旧数据缺少计划元信息仍可解析', () => {
    const input: Record<string, unknown> = { ...validRoadmap() }
    delete input.summary
    delete input.overallDuration
    delete input.sessionsPerWeek
    delete input.sessionMinutes
    expect(parseRoadmapContent(input)).not.toBeNull()
  })

  it('工具 schema 要求计划元信息必填', () => {
    const input: Record<string, unknown> = { ...validRoadmap() }
    delete input.summary
    expect(roadmapToolSchema.safeParse(input).success).toBe(false)
  })

  it('每周次数越界不合法', () => {
    const input = { ...validRoadmap(), sessionsPerWeek: 0 }
    expect(parseRoadmapContent(input)).toBeNull()
  })

  it('endDate 早于 startDate 不合法', () => {
    const input = { ...validRoadmap(), startDate: '2026-11-05', endDate: '2026-11-01' }
    expect(parseRoadmapContent(input)).toBeNull()
  })

  it('日期格式不是 YYYY-MM-DD 不合法', () => {
    const input = { ...validRoadmap(), startDate: '2026/11/05' }
    expect(parseRoadmapContent(input)).toBeNull()
  })

  it('训练结束时间早于开始时间不合法', () => {
    const input = validRoadmap()
    input.phases[0].sessions[0].endTime = '19:00'
    expect(parseRoadmapContent(input)).toBeNull()
  })

  it('训练时间格式不是 HH:MM 不合法', () => {
    const input = validRoadmap()
    input.phases[0].sessions[0].startTime = '8:00'
    expect(parseRoadmapContent(input)).toBeNull()
  })

  it('完成状态与建议在解析后保留', () => {
    const base = validRoadmap()
    const input = {
      ...base,
      phases: base.phases.map((phase, index) =>
        index === 0
          ? {
              ...phase,
              sessions: [
                {
                  ...phase.sessions[0],
                  status: 'done',
                  completionNote: '写完了受控表单',
                  feedback: '表单结构没问题，下次把校验逻辑抽出来。',
                  completedAt: '2026-11-05T12:00:00.000Z',
                },
              ],
            }
          : phase,
      ),
    }
    const content = parseRoadmapContent(input)
    expect(content?.phases[0].sessions[0].status).toBe('done')
    expect(content?.phases[0].sessions[0].feedback).toContain('表单结构')
  })

  it('空字符串不合法', () => {
    const input = validRoadmap()
    input.phases[0].sessions[0].task = ''
    expect(parseRoadmapContent(input)).toBeNull()
  })
})
