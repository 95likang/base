import { LangfuseSpanProcessor } from '@langfuse/otel'
import {
  type PropagateAttributesParams,
  propagateAttributes,
  startActiveObservation,
} from '@langfuse/tracing'
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { registerTelemetry } from 'ai'
import { config } from './config/loader'
import { maskTraceData } from './trace/mask'

const { enabled, publicKey, secretKey, baseUrl } = config.observability

/** 配置开启且两个 key 都存在才启用；否则所有观测调用退化为直接执行 */
const active = enabled && Boolean(publicKey && secretKey)

let sdk: NodeSDK | undefined

if (active) {
  sdk = new NodeSDK({
    spanProcessors: [
      // 凭证显式传入，不走 LANGFUSE_* 环境变量，配置文件是唯一真相
      new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        baseUrl: baseUrl || undefined,
        mask: maskTraceData,
      }),
    ],
  })
  sdk.start()
  // 只需注册一次：之后所有 streamText / generateText 调用自动产出 step、tool 与 token span
  registerTelemetry(new LangfuseVercelAiSdkIntegration())
  console.log(`  ✓ Langfuse 已启用 (${baseUrl || 'https://cloud.langfuse.com'})`)
}

/** 给一次请求挂 trace 级属性（名称/会话/元数据）；未启用时零开销直接执行 */
export function withTraceAttributes<T>(
  attributes: PropagateAttributesParams,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sdk) return fn()
  // 必须建根 span：否则循环里每个 streamText 各自成根、各开一个 trace，
  // 一次请求被拆散。根 span 让所有 step/generation/sub-agent 共享同一个 traceId
  return propagateAttributes(attributes, () =>
    startActiveObservation(attributes.traceName ?? 'request', async () => fn()),
  )
}

let flushing = false

/** 进程退出前尽力把缓冲区里的 span 发出去；失败只告警，不影响退出 */
export async function flushObservability(): Promise<void> {
  if (!sdk || flushing) return
  flushing = true
  try {
    await sdk.shutdown()
  } catch (error) {
    console.warn(
      `  [Langfuse] 退出前 flush 失败: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
