import { beforeEach, describe, expect, it, vi } from 'vitest'

const { generateText } = vi.hoisted(() => ({ generateText: vi.fn() }))
vi.mock('ai', () => ({ generateText }))

const { getRoadmap, updateRoadmapContent } = vi.hoisted(() => ({
  getRoadmap: vi.fn(),
  updateRoadmapContent: vi.fn(),
}))
vi.mock('./store', () => ({ getRoadmap, updateRoadmapContent }))
vi.mock('../agent/model', () => ({ defaultModel: 'test-model' }))

import { completeSession } from './service'

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    subskill: '状态提升',
    task: '把三个子组件的输入状态提升到父组件',
    criteria: '父组件持有全部状态，子组件无 useState',
    minutes: 40,
    product: '一份可运行的受控表单',
    date: '2026-11-05',
    startTime: '20:00',
    endTime: '20:40',
    ...overrides,
  }
}

function makeRow(session: Record<string, unknown> = makeSession()) {
  return {
    id: 'roadmap-1',
    chatId: 'chat-1',
    content: {
      title: 'React 实战训练',
      goal: '独立拆出组件边界',
      summary: '从组件基础开始',
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
          criteria: '不看文档写出带校验的受控表单',
          focus: '状态提升',
          sessions: [session],
        },
      ],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

describe('完成一次训练', () => {
  beforeEach(() => {
    getRoadmap.mockReset()
    updateRoadmapContent.mockReset()
    generateText.mockReset()
  })

  it('生成建议后写回完成状态', async () => {
    getRoadmap.mockResolvedValue(makeRow())
    generateText.mockResolvedValue({ text: ' 这次状态提升做对了，下次把校验逻辑抽出来。 ' })
    updateRoadmapContent.mockResolvedValue(undefined)

    const content = await completeSession({
      roadmapId: 'roadmap-1',
      phaseIndex: 0,
      sessionIndex: 0,
      note: '把三个输入都提到父组件了',
    })

    const session = content.phases[0].sessions[0]
    expect(session.status).toBe('done')
    expect(session.completionNote).toBe('把三个输入都提到父组件了')
    expect(session.feedback).toBe('这次状态提升做对了，下次把校验逻辑抽出来。')
    expect(session.completedAt).toBeTruthy()
    expect(updateRoadmapContent).toHaveBeenCalledTimes(1)
  })

  it('已完成的训练不能再次提交', async () => {
    getRoadmap.mockResolvedValue(makeRow(makeSession({ status: 'done' })))

    await expect(
      completeSession({ roadmapId: 'roadmap-1', phaseIndex: 0, sessionIndex: 0, note: '再交一次' }),
    ).rejects.toThrow('Session already completed.')
    expect(updateRoadmapContent).not.toHaveBeenCalled()
  })

  it('计划或训练不存在时返回对应错误', async () => {
    getRoadmap.mockResolvedValue(null)
    await expect(
      completeSession({ roadmapId: 'x', phaseIndex: 0, sessionIndex: 0, note: 'note' }),
    ).rejects.toThrow('Roadmap not found.')

    getRoadmap.mockResolvedValue(makeRow())
    await expect(
      completeSession({ roadmapId: 'roadmap-1', phaseIndex: 9, sessionIndex: 0, note: 'note' }),
    ).rejects.toThrow('Session not found.')
    expect(updateRoadmapContent).not.toHaveBeenCalled()
  })

  it('建议生成失败时不写库', async () => {
    getRoadmap.mockResolvedValue(makeRow())
    generateText.mockRejectedValue(new Error('upstream down'))

    await expect(
      completeSession({ roadmapId: 'roadmap-1', phaseIndex: 0, sessionIndex: 0, note: 'note' }),
    ).rejects.toThrow('Failed to generate feedback.')
    expect(updateRoadmapContent).not.toHaveBeenCalled()
  })
})
