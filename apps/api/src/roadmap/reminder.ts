import { config } from '../config/loader'
import { cronService } from '../cron'
import type { RoadmapContent } from './spec'

type PlanRef = { id: string; content: RoadmapContent }

/**
 * 下一场该练的训练：按计划顺序（阶段 → 阶段内序号）取第一个未完成的。
 * 顺序即执行顺序，完成按钮也按这个顺序解锁，所以这里不按日期排序。
 */
function nextSession(content: RoadmapContent) {
  for (const phase of content.phases) {
    for (const session of phase.sessions) {
      if (session.status !== 'done') return session
    }
  }
  return undefined
}

/**
 * 把提醒同步到「下一场训练的开始时刻」。
 * 显式写 +08:00：不带偏移的时间会被解析成服务器本地时区，服务器换成 UTC 就会错 8 小时。
 */
function startOf(session: { date?: string; startTime?: string }): Date | undefined {
  if (!session.date || !session.startTime) return undefined
  return new Date(`${session.date}T${session.startTime}:00+08:00`)
}

/**
 * 重建「下一场训练开始」提醒。
 * 没有可用的训练时间、或开始时刻已过都不建——调度器会把逾期的一次性任务立即补跑，
 * 等于在用户已经开工之后才发提醒，不如不发。
 * 失败只记日志：提醒是附加动作，不能连累计划本身的生成或完成写入。
 */
export async function syncRoadmapReminder(plan: PlanRef): Promise<void> {
  try {
    await removeRoadmapReminder(plan.id)

    const session = nextSession(plan.content)
    const startAt = session ? startOf(session) : undefined
    if (!session || !startAt) return
    if (Number.isNaN(startAt.getTime()) || startAt.getTime() <= Date.now()) return

    await cronService.add({
      // 一个计划对应一个固定任务 id：每次完成/重生成都是先删后建，天然幂等
      id: `roadmap-reminder:${plan.id}`,
      name: `训练提醒 · ${plan.content.title}`,
      schedule: startAt.toISOString(),
      scheduleType: 'once',
      enabled: true,
      source: 'runtime',
      payload: {
        type: 'reminder',
        text: `训练计划《${plan.content.title}》该开始了：${session.subskill}。查看计划：${config.server.webUrl}/plans/${plan.id}`,
        actions: 'none',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(`  [roadmap] 同步训练提醒失败: ${message}`)
  }
}

/** 计划删除后清理提醒；任务已执行完（已自动删除）时什么也不做 */
export async function removeRoadmapReminder(roadmapId: string): Promise<void> {
  await cronService.remove(`roadmap-reminder:${roadmapId}`)
}
