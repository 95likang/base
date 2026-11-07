import { beforeEach, describe, expect, it, vi } from 'vitest'

/** cronService 会写 cron_job 表，测试里只关心被调用成什么样 */
const { cronService } = vi.hoisted(() => ({
  cronService: { add: vi.fn(), remove: vi.fn() },
}))
vi.mock('../cron', () => ({ cronService }))

vi.mock('../config/loader', () => ({ config: { server: { webUrl: 'https://coach.example.com' } } }))

import { removeRoadmapReminder, syncRoadmapReminder } from './reminder'

type Session = { date?: string; startTime?: string; status?: 'done'; subskill: string }

function plan(...phases: Session[][]) {
  return {
    id: 'roadmap-1',
    content: { title: '游泳 25 米', phases: phases.map((sessions) => ({ sessions })) },
  } as never
}

describe('训练提醒', () => {
  beforeEach(() => {
    cronService.add.mockReset()
    cronService.remove.mockReset()
  })

  it('提醒指向下一场未完成的训练：北京时间换算成 UTC、无按钮、带计划链接', async () => {
    await syncRoadmapReminder(
      plan([{ date: '2099-01-01', startTime: '20:00', subskill: '水下呼气' }]),
    )

    // 每次同步先删旧任务，避免留着旧时间的提醒
    expect(cronService.remove).toHaveBeenCalledWith('roadmap-reminder:roadmap-1')
    expect(cronService.add).toHaveBeenCalledWith({
      id: 'roadmap-reminder:roadmap-1',
      name: '训练提醒 · 游泳 25 米',
      schedule: '2099-01-01T12:00:00.000Z',
      scheduleType: 'once',
      enabled: true,
      source: 'runtime',
      payload: {
        type: 'reminder',
        text: '训练计划《游泳 25 米》该开始了：水下呼气。查看计划：https://coach.example.com/plans/roadmap-1',
        actions: 'none',
      },
    })
  })

  it('上一场完成后，提醒改指向后面第一场未完成的训练（跨阶段）', async () => {
    await syncRoadmapReminder(
      plan(
        [
          { date: '2099-01-01', startTime: '20:00', status: 'done', subskill: '水下呼气' },
          { date: '2099-01-08', startTime: '16:10', subskill: '漂浮起身' },
        ],
        [{ date: '2099-01-15', startTime: '09:00', subskill: '打腿' }],
      ),
    )

    expect(cronService.add).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: '2099-01-08T08:10:00.000Z' }),
    )
  })

  it('全部完成时只清理旧任务，不再建提醒', async () => {
    await syncRoadmapReminder(
      plan([{ date: '2099-01-01', startTime: '20:00', status: 'done', subskill: '水下呼气' }]),
    )

    expect(cronService.remove).toHaveBeenCalledWith('roadmap-reminder:roadmap-1')
    expect(cronService.add).not.toHaveBeenCalled()
  })

  it('下一场已经开始时只清理旧任务，不发提醒', async () => {
    await syncRoadmapReminder(
      plan([{ date: '2020-01-01', startTime: '09:00', subskill: '水下呼气' }]),
    )

    expect(cronService.remove).toHaveBeenCalledWith('roadmap-reminder:roadmap-1')
    expect(cronService.add).not.toHaveBeenCalled()
  })

  it('旧记录没有训练时间时不建提醒', async () => {
    await syncRoadmapReminder(plan([{ subskill: '水下呼气' }]))

    expect(cronService.add).not.toHaveBeenCalled()
  })

  it('建任务失败只记日志，不把异常抛给计划写入方', async () => {
    cronService.add.mockRejectedValueOnce(new Error('任务数量已达上限 50'))

    await expect(
      syncRoadmapReminder(plan([{ date: '2099-01-01', startTime: '20:00', subskill: '水下呼气' }])),
    ).resolves.toBeUndefined()
  })

  it('删除计划时按固定 id 清理任务', async () => {
    await removeRoadmapReminder('roadmap-1')

    expect(cronService.remove).toHaveBeenCalledWith('roadmap-reminder:roadmap-1')
  })
})
