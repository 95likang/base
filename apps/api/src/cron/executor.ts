import type { ModelMessage, UIMessageStreamWriter } from 'ai'
import { agentLoop, type BudgetState, TOKEN_BUDGET } from '../agent/loop'
import { defaultModel } from '../agent/model'
import { config } from '../config/loader'
import { buildRuntimeSystem } from '../context/runtime-prompt'
import { createDefaultToolRegistry } from '../tools/default-registry'
import { usageLog } from '../usage'
import { cronService } from './index'

/**
 * 启动调度器并注入 Agent 执行器。
 * 每次执行新建请求级工具注册表，与对话 / Channel 的锁状态互不干扰。
 */
export async function startCron(): Promise<void> {
  try {
    await cronService.load()
  } catch (err) {
    // 表未创建时不让整个 API 启动失败，只停用定时任务并给出明确提示
    const message = err instanceof Error ? err.message : String(err)
    console.log(`  Cron 启动失败: ${message}`)
    console.log('  请先执行: pnpm --filter api db:push')
    return
  }
  cronService.setExecutor({
    runAgentPrompt: async (prompt, timeout = 60_000) => {
      const model = defaultModel
      const budget: BudgetState = { used: 0, limit: TOKEN_BUDGET }
      const registry = await createDefaultToolRegistry({ budget })
      const messages: ModelMessage[] = [{ role: 'user', content: prompt }]
      const system = await buildRuntimeSystem(registry, 'cron', messages.length)

      // 超时用 AbortSignal 传导到 agentLoop：停止后续 LLM 调用，而不是只丢弃结果
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      // 只保留最后一个文本块：工具步骤前的旁白不应出现在任务输出里
      let reply = ''
      const writer: UIMessageStreamWriter = {
        write(chunk) {
          if (chunk.type === 'text-start') reply = ''
          else if (chunk.type === 'text-delta') reply += chunk.delta
        },
        merge() {},
        onError: undefined,
      }
      try {
        await agentLoop(
          model,
          registry.toAISDKFormat(),
          messages,
          system,
          writer,
          controller.signal,
          budget,
          undefined,
          usageLog,
          'cron',
        )
      } catch (err) {
        if (controller.signal.aborted) throw new Error(`timeout: 执行超过 ${timeout}ms`)
        throw err
      } finally {
        clearTimeout(timer)
      }

      return reply.trim() || '(无输出)'
    },
    notify: (message) => {
      console.log(`\n${message}`)
    },
  })
  // cron.enabled=false 只关闭自动调度：任务仍会加载、可在管理页手动运行
  if (!config.cron.enabled) {
    console.log('  Cron 自动调度已关闭（cron.enabled=false）')
    return
  }
  cronService.start()
}
