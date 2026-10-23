import { SubAgentRegistry } from './registry'

/** 进程级单例：spawn 工具、/api/agents 与管理页共用同一份运行记录 */
export const subAgentRegistry = new SubAgentRegistry()
