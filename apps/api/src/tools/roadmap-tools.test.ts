import { beforeEach, describe, expect, it, vi } from 'vitest'

/** store 会 import ../db（缺 DATABASE_URL 时直接抛错），测试里整体打桩 */
const { createRoadmap } = vi.hoisted(() => ({ createRoadmap: vi.fn() }))
vi.mock('../roadmap/store', () => ({ createRoadmap }))

import { createRoadmapTool } from './roadmap-tools'

function validInput() {
  return {
    title: 'React 实战训练',
    goal: '给一个陌生需求，独立拆出组件边界',
    summary: '从组件基础到性能优化，三个阶段逐步推进',
    overallDuration: '8 周',
    startDate: '2026-11-05',
    endDate: '2027-01-05',
    sessionsPerWeek: 3,
    sessionMinutes: 45,
    currentPhaseIndex: 0,
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
    ],
  }
}

describe('practice_roadmap 工具', () => {
  beforeEach(() => {
    createRoadmap.mockReset()
    createRoadmap.mockResolvedValue({ id: 'roadmap-1' })
  })

  it('合法输入写入后只返回 roadmapId', async () => {
    const tool = createRoadmapTool({ chatId: 'chat-1' })
    const result = await tool.execute(validInput(), {})

    expect(result).toEqual({ roadmapId: 'roadmap-1' })
    expect(createRoadmap).toHaveBeenCalledTimes(1)

    const [call] = createRoadmap.mock.calls
    expect(call[0].chatId).toBe('chat-1')
    // 落库的是 zod 重建后的对象，不是模型原始输入
    expect(call[0].content.phases).toHaveLength(1)
  })

  it('currentPhaseIndex 越界时抛错，且不写库', async () => {
    const tool = createRoadmapTool({ chatId: 'chat-1' })
    const input = { ...validInput(), currentPhaseIndex: 5 }

    await expect(tool.execute(input, {})).rejects.toThrow('路线图内容不合法')
    expect(createRoadmap).not.toHaveBeenCalled()
  })

  it('字段越界时抛错，且不写库', async () => {
    const tool = createRoadmapTool({ chatId: 'chat-1' })
    const input = validInput()
    input.phases[0].sessions[0].minutes = 500

    await expect(tool.execute(input, {})).rejects.toThrow('路线图内容不合法')
    expect(createRoadmap).not.toHaveBeenCalled()
  })

  it('缺少计划元信息时抛错，且不写库', async () => {
    const tool = createRoadmapTool({ chatId: 'chat-1' })
    const input: Record<string, unknown> = { ...validInput() }
    delete input.summary

    await expect(tool.execute(input, {})).rejects.toThrow('路线图内容不合法')
    expect(createRoadmap).not.toHaveBeenCalled()
  })

  it('endDate 早于 startDate 时抛错，且不写库', async () => {
    const tool = createRoadmapTool({ chatId: 'chat-1' })
    const input = { ...validInput(), startDate: '2026-11-05', endDate: '2026-11-01' }

    await expect(tool.execute(input, {})).rejects.toThrow('endDate 早于 startDate')
    expect(createRoadmap).not.toHaveBeenCalled()
  })

  it('训练结束时间早于开始时间时抛错，且不写库', async () => {
    const tool = createRoadmapTool({ chatId: 'chat-1' })
    const input = validInput()
    input.phases[0].sessions[0].startTime = '21:00'
    input.phases[0].sessions[0].endTime = '20:00'

    await expect(tool.execute(input, {})).rejects.toThrow('结束时间必须晚于开始时间')
    expect(createRoadmap).not.toHaveBeenCalled()
  })
})
