import { CronService } from './service'

/**
 * 进程级单例：管理页路由、cron_manage 工具、启动流程共用同一个调度器实例。
 * 任务定义与日志持久化在 PostgreSQL（cron_job / cron_run_log）。
 */
export const cronService = new CronService()
