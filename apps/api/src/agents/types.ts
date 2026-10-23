/** 子 Agent 的运行约束 */
export interface SubAgentConfig {
  /** 最大嵌套深度（当前子 Agent 内不暴露 spawn_agent，实际不会超过 1） */
  maxSpawnDepth: number
  /** 最大并发子 Agent 数（进程级） */
  maxConcurrent: number
  /** 默认执行超时 ms */
  defaultTimeout: number
}

export const DEFAULT_CONFIG: SubAgentConfig = {
  maxSpawnDepth: 1,
  maxConcurrent: 3,
  defaultTimeout: 60_000,
}

export interface SpawnRequest {
  /** 子 Agent 的任务描述 */
  task: string
}

export type SubAgentStatus = 'running' | 'completed' | 'error' | 'timeout'

export interface SubAgentRun {
  id: string
  task: string
  status: SubAgentStatus
  depth: number
  startedAt: string
  finishedAt?: string
  /** 执行结果文本（只保留最后一条 assistant 消息） */
  result?: string
  error?: string
}
