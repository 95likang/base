import { detectScheduleType } from '../cron/parser'
import type { CronService } from '../cron/service'
import type { CronJobConfig } from '../cron/types'
import type { ToolDefinition } from './registry'

interface CronToolInput {
  action: 'list' | 'add' | 'remove' | 'run' | 'enable' | 'disable' | 'logs'
  id?: string
  name?: string
  schedule?: string
  prompt?: string
  handler?: string
}

/**
 * cron_manage：面向模型的定时任务管理入口。
 * 所有 CRUD 合并到一个工具（按 action 分派）：工具越少，模型选择越准、schema 占用的 token 越少。
 */
export function createCronTool(cronService: CronService): ToolDefinition {
  return {
    name: 'cron_manage',
    description:
      '管理定时任务。支持创建、删除、查看、立即执行、启用/禁用定时任务与查看执行日志。' +
      '调度表达式支持 cron("*/5 * * * *")、间隔("every 30s")、一次性(ISO 时间戳)；' +
      '固定间隔最小 10s，任务总数最多 50 个。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'run', 'enable', 'disable', 'logs'],
          description: '操作类型',
        },
        id: { type: 'string', description: '任务 ID（add/remove/run/enable/disable/logs 时必填）' },
        name: { type: 'string', description: '任务名称（add 时必填）' },
        schedule: {
          type: 'string',
          description: '调度表达式：cron、间隔("every 30s")或一次性 ISO 时间戳（add 时必填）',
        },
        prompt: {
          type: 'string',
          description: '任务执行时发送给 Agent 的 prompt（与 handler 二选一）',
        },
        handler: {
          type: 'string',
          description: '内置 handler 名称，如 "random-quote"（与 prompt 二选一）',
        },
      },
      required: ['action'],
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (input: CronToolInput) => {
      switch (input.action) {
        case 'list': {
          const jobs = cronService.list()
          if (jobs.length === 0) return '当前没有定时任务'
          return jobs
            .map((job) => {
              const last = job.lastRun
                ? ` | 上次: ${job.lastRun.status} @ ${job.lastRun.finishedAt}`
                : ''
              return `[${job.status}] ${job.config.id} — ${job.config.name}\n  调度: ${job.config.schedule}${last}`
            })
            .join('\n\n')
        }
        case 'add': {
          if (!input.id || !input.name || !input.schedule || (!input.prompt && !input.handler)) {
            return '添加任务需要: id, name, schedule, prompt 或 handler'
          }
          const payload = input.handler
            ? ({ type: 'handler', handler: input.handler } as const)
            : ({ type: 'agent', prompt: input.prompt ?? '' } as const)
          const config: CronJobConfig = {
            id: input.id,
            name: input.name,
            schedule: input.schedule,
            scheduleType: detectScheduleType(input.schedule),
            enabled: true,
            payload,
            source: 'runtime',
          }
          try {
            await cronService.add(config)
            return `✓ 任务 "${input.name}" 已创建，调度: ${input.schedule}`
          } catch (err) {
            return `✗ 创建失败: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        case 'remove':
          if (!input.id) return '需要指定任务 id'
          return (await cronService.remove(input.id))
            ? `✓ 任务 ${input.id} 已删除`
            : `✗ 任务 ${input.id} 不存在`
        case 'run':
          if (!input.id) return '需要指定任务 id'
          return await cronService.runNow(input.id)
        case 'enable':
          if (!input.id) return '需要指定任务 id'
          return (await cronService.enable(input.id)) ? '✓ 已启用' : '✗ 任务不存在'
        case 'disable':
          if (!input.id) return '需要指定任务 id'
          return (await cronService.disable(input.id)) ? '✓ 已禁用' : '✗ 任务不存在'
        case 'logs': {
          const logs = await cronService.getRecentLogs(input.id, 5)
          if (logs.length === 0) return '暂无执行记录'
          return logs
            .map(
              (log) =>
                `[${log.status}] ${log.jobId} @ ${log.startedAt}\n  ${
                  log.output?.slice(0, 100) || log.error || ''
                }`,
            )
            .join('\n\n')
        }
        default:
          return `未知操作: ${String(input.action)}`
      }
    },
  }
}
