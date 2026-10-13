import { jsonSchema, type ToolSet } from 'ai'

/** 结果截断默认上限（字符数），超出部分头尾保留、中间省略 */
const DEFAULT_MAX_RESULT_CHARS = 3000

/** execute 收到的运行时选项（由 AI SDK 传入，abortSignal 随请求取消触发） */
export interface ToolExecuteOptions {
  abortSignal?: AbortSignal
}

/**
 * 工具定义 —— 注册层的契约。
 * 工具作者只关心：叫什么、干什么、参数长什么样、怎么执行；
 * 并发协调与结果截断由注册表统一施加，工具自身不感知。
 */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema 格式的参数定义（AI SDK jsonSchema() 直接消费） */
  parameters: Record<string, unknown>
  /**
   * 并发安全：true = 与其他工具并行执行（共享锁）；
   * false/未设置 = 独占执行，等待所有在途工具完成且期间不允许新工具插入。
   * 有副作用的工具（写库、发请求）应设为 false。
   */
  isConcurrencySafe?: boolean
  /** 只读（无副作用）：目前作为自描述元数据，预留给将来的权限/审计层 */
  isReadOnly?: boolean
  /** 结果截断上限（字符数），默认 3000 */
  maxResultChars?: number
  // biome-ignore lint/suspicious/noExplicitAny: 入参来自 LLM、按 parameters 的 JSON Schema 动态校验，无静态类型
  execute: (input: any, options: ToolExecuteOptions) => Promise<unknown>
}

/**
 * 工具注册表 —— 三层职责的编排点。
 *
 * 1. 注册层：register/get/getAll，持有工具目录；
 * 2. 执行层：toAISDKFormat 包装 execute，施加读写锁——
 *    并发安全工具之间共享并行；非安全工具独占（读写锁语义）；
 * 3. 截断层：结果统一序列化 + truncateResult，防超长输出撑爆上下文。
 *
 * 锁状态是请求级的：每个 agentLoop 持有独立实例（与 loop-guard 同理），
 * 只协调单次请求内同一步骤的并行工具调用，不跨请求。
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  // —— 读写锁状态（全部在 execute 包装层内部使用）——
  private exclusiveLock = false
  private concurrentCount = 0
  /** 共享一个等待队列：唤醒后各自重检查条件，条件不满足则重新入队 */
  private waitQueue: Array<() => void> = []

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  /** 共享锁：只要没有独占者在执行/等待唤醒，即可立即进入 */
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r))
    }
    this.concurrentCount++
  }

  private releaseConcurrent(): void {
    this.concurrentCount--
    if (this.concurrentCount === 0) this.drainQueue()
  }

  /** 独占锁：等所有共享持有者退出后进入；执行期间阻塞一切后续获取 */
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r))
    }
    this.exclusiveLock = true
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false
    this.drainQueue()
  }

  /**
   * 唤醒全部等待者（惊群）：每个等待者在 while 循环里重检查自己的
   * 进入条件，不满足就重新入队。单线程事件循环下这是正确的，
   * 极端情况（持续不断的共享锁流量）可能让独占者等待较久，
   * 但 agentLoop 的 MAX_STEPS 上限保证了不会无限饿死。
   */
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0)
    for (const resolve of waiting) resolve()
  }

  /**
   * 执行层 + 截断层：把工具目录转换为 AI SDK 的 ToolSet。
   * execute 包装不改变工具的返回值语义——
   * 序列化为字符串、截断、加锁，全部对模型透明。
   */
  toAISDKFormat(): ToolSet {
    const result: Record<string, unknown> = {}
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
      const executeFn = tool.execute
      const isSafe = tool.isConcurrencySafe === true

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters),
        // biome-ignore lint/suspicious/noExplicitAny: 入参类型由 ToolDefinition.execute 约定，透传即可
        execute: async (input: any, options: ToolExecuteOptions) => {
          if (isSafe) {
            await this.acquireConcurrent()
          } else {
            await this.acquireExclusive()
          }
          try {
            const raw = await executeFn(input, options)
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
            return truncateResult(text, maxChars)
          } finally {
            if (isSafe) {
              this.releaseConcurrent()
            } else {
              this.releaseExclusive()
            }
          }
        },
      }
    }
    return result as ToolSet
  }
}

/**
 * 截断层：超长结果保留头尾、省略中间。
 * 头部保留结果的主干信息（JSON 的键名、开头字段），
 * 尾部保留收尾信息，模型两头都能接上语义。
 */
export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  // 非法上限（0/负数）回退默认值，避免产出空结果
  if (!(maxChars > 0)) maxChars = DEFAULT_MAX_RESULT_CHARS
  if (text.length <= maxChars) return text

  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  const head = text.slice(0, headSize)
  const tail = text.slice(-tailSize)
  const dropped = text.length - headSize - tailSize

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`
}
