import type { BudgetState } from '../agent/loop'
import type { SubAgentRegistry } from '../agents/registry'
import type { SpawnContext } from '../agents/spawn'
import { spawnAgent, spawnParallel } from '../agents/spawn'
import type { ToolDefinition, ToolRegistry } from './registry'

/**
 * spawn_agent：把派生能力暴露给模型。
 * 子 Agent 用独立上下文执行，只回传结论；tasks 数组并行执行多个独立任务。
 * 工具本身标记为独占（不可并发安全）：一次 spawn 是重量级操作，
 * 但子 Agent 内部用的是 fork 出的独立注册表，不会与父 Agent 的锁互相等待。
 */
export function createSpawnTool(
  agentRegistry: SubAgentRegistry,
  registry: ToolRegistry,
  budget?: BudgetState,
): ToolDefinition {
  return {
    name: 'spawn_agent',
    description:
      '派子 Agent 去执行任务。子 Agent 拥有独立上下文，完成后只返回结果摘要（中间的探索过程不会占用当前上下文）。' +
      '涉及多个独立目标的调研、对比、分析时，用 tasks 一次并行派发；超出并发额度会自动排队。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '单个任务描述（与 tasks 二选一）',
        },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: '多个独立任务描述，并行执行（与 task 二选一）',
        },
      },
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    maxResultChars: 8000,
    execute: async (
      input: { task?: string; tasks?: string[] },
      options: { abortSignal?: AbortSignal },
    ) => {
      const ctx: SpawnContext = {
        registry,
        agentRegistry,
        currentDepth: 0,
        signal: options.abortSignal,
        budget,
      }

      if (input.tasks && input.tasks.length > 0) {
        const results = await spawnParallel(
          input.tasks.map((task) => ({ task })),
          ctx,
        )
        return results
          .map((r, i) => `## 子 Agent ${i + 1}: ${r.task.slice(0, 40)}\n\n${r.result}`)
          .join('\n\n---\n\n')
      }

      if (input.task) {
        return spawnAgent({ task: input.task }, ctx)
      }

      return '需要提供 task 或 tasks 参数'
    },
  }
}
