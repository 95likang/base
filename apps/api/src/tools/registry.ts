import { jsonSchema, type ToolSet } from 'ai'
import { classifyBashCommand } from '../security/bash-classifier'
import type { HookPipeline } from '../security/hooks'
import { canUseTool, type Role } from '../security/roles'

/** 结果截断默认上限（字符数），超出部分头尾保留、中间省略 */
const DEFAULT_MAX_RESULT_CHARS = 3000
/** 日志里的命令长度上限：避免把命令中的密钥等敏感信息整段写进日志 */
const LOG_COMMAND_MAX_CHARS = 120

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
  /**
   * 纯渲染型工具：前端负责画，服务端没有实际业务逻辑。
   * agentLoop 检测到本步全部调用都是渲染型时立即结束，不再多跑一轮模型调用。
   */
  renderOnly?: boolean
  /** 结果截断上限（字符数），默认 3000 */
  maxResultChars?: number
  /**
   * 延迟加载：true 时不进入初始 ToolSet（省上下文），
   * 模型需先通过 tool_search 按名获取后才激活（激活后一直可用）。
   * 适合工具数量多的来源（如 MCP server）。
   */
  shouldDefer?: boolean
  /** 延迟工具的检索提示（名字/功能关键词），展示在系统提示的延迟工具列表里 */
  searchHint?: string
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

  // —— 延迟加载状态 ——
  /** 已通过 searchTools 激活的延迟工具名 */
  private discoveredTools = new Set<string>()
  /** toAISDKFormat 最近产出的 ToolSet 引用：激活新工具时原地更新，让进行中的 agentLoop 立即可见 */
  private emittedSet: Record<string, unknown> | undefined

  // —— 安全状态 ——
  private currentRole: Role = 'owner'
  private hookPipeline: HookPipeline | undefined

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

  /** 切换当前角色：角色不允许的工具不会暴露给模型 */
  setRole(role: Role): void {
    this.currentRole = role
  }

  /** 注入 Hook 管线：工具执行前后触发 */
  setHookPipeline(pipeline: HookPipeline): void {
    this.hookPipeline = pipeline
  }

  /** 当前激活的工具（延迟未发现、角色不允许的工具排除在外） */
  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => !this.isDeferred(tool) && this.isAllowed(tool))
  }

  /**
   * 纯渲染型工具名集合：agentLoop 据此判断本步是否只画图、不再请求下一轮。
   * 只统计真正暴露给模型的工具（延迟未激活 / 角色不允许的不算），
   * 否则 prompt 会引导模型调用一个根本不可见的工具。
   */
  getRenderToolNames(): ReadonlySet<string> {
    return new Set(
      this.getActiveTools()
        .filter((tool) => tool.renderOnly === true)
        .map((tool) => tool.name),
    )
  }

  /** 角色是否允许使用该工具 */
  private isAllowed(tool: ToolDefinition): boolean {
    return canUseTool(this.currentRole, tool.name)
  }

  /** 是否处于"延迟且未激活"状态 */
  private isDeferred(tool: ToolDefinition): boolean {
    return tool.shouldDefer === true && !this.discoveredTools.has(tool.name)
  }

  /**
   * 延迟工具列表（拼接进系统提示），告知模型有哪些工具可通过 tool_search 激活。
   * 没有延迟工具时返回空字符串。
   */
  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter((tool) => this.isDeferred(tool) && this.isAllowed(tool))
    if (deferred.length === 0) return ''

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : ''
      return `  - ${t.name}${hint}`
    })
    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`
  }

  /**
   * 激活延迟工具，返回激活结果。
   * 匹配顺序：先按精确名（支持逗号分隔多个名字，如
   * "mcp__github__list_issues,mcp__github__search_repositories"）；
   * 全部未命中时按 name/searchHint 子串兜底（大小写不敏感），
   * 模型记不全长全名也能用关键词找到。
   * 激活即原地写入最近产出的 ToolSet：agentLoop 每步复用同一引用，
   * 后续步骤的 streamText 能直接看到新工具，无需重传 tools。
   * 只激活延迟工具——普通工具本就在初始 ToolSet 里。
   */
  searchTools(query: string): ToolDefinition[] {
    const activate = (tool: ToolDefinition, results: ToolDefinition[]) => {
      this.discoveredTools.add(tool.name)
      results.push(tool)
      if (this.emittedSet) {
        this.emittedSet[tool.name] = this.wrapTool(tool)
      }
    }

    const names = query
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)

    const results: ToolDefinition[] = []
    for (const name of names) {
      const tool = this.tools.get(name)
      if (tool && tool.shouldDefer === true && this.isAllowed(tool)) {
        activate(tool, results)
      }
    }
    if (results.length > 0) return results

    // 精确名未命中 → 子串兜底；空 query 不能进兜底（'' 的 includes 恒真，会激活全部延迟工具）
    const q = query.trim().toLowerCase()
    if (!q) return []
    for (const tool of this.tools.values()) {
      if (
        this.isDeferred(tool) &&
        this.isAllowed(tool) &&
        (tool.name.toLowerCase().includes(q) || tool.searchHint?.toLowerCase().includes(q))
      ) {
        activate(tool, results)
      }
    }
    return results
  }

  /**
   * 工具定义的 Token 用量估算（JSON 序列化长度 / 4，粗略近似）：
   * active = 进入初始 ToolSet 的工具；deferred = 延迟未激活、不占 prompt 的工具。
   * 用于日志观测延迟加载的省 token 效果。
   */
  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0
    let deferred = 0
    for (const tool of this.tools.values()) {
      if (!this.isAllowed(tool)) continue
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length
      const tokens = Math.ceil(schemaSize / 4)
      if (this.isDeferred(tool)) {
        deferred += tokens
      } else {
        active += tokens
      }
    }
    return { active, deferred, total: active + deferred }
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
   * bash 风险检测：危险命令返回拒绝文案（工具不执行）；中风险只告警。
   * 非 bash 工具（或没有 command 字段）直接放行。
   */
  private bashRiskRejection(input: unknown): string | undefined {
    const command = (input as { command?: unknown } | undefined)?.command
    if (typeof command !== 'string') return undefined

    const risk = classifyBashCommand(command)
    if (risk.level === 'dangerous') {
      return `[拒绝执行] 检测到危险操作: ${risk.reason}\n命令: ${command}`
    }
    if (risk.level === 'moderate') {
      const shown =
        command.length > LOG_COMMAND_MAX_CHARS
          ? `${command.slice(0, LOG_COMMAND_MAX_CHARS)}…`
          : command
      console.log(`  [安全] ⚠ ${risk.reason}: ${shown}`)
    }
    return undefined
  }

  /**
   * 执行层 + 截断层：把单个工具包装为 AI SDK 的工具条目。
   * execute 包装不改变工具的返回值语义——
   * 序列化为字符串、截断、加锁，全部对模型透明。
   */
  private wrapTool(tool: ToolDefinition): Record<string, unknown> {
    const maxChars = tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
    const executeFn = tool.execute
    const isSafe = tool.isConcurrencySafe === true

    return {
      description: tool.description,
      inputSchema: jsonSchema(tool.parameters),
      // biome-ignore lint/suspicious/noExplicitAny: 入参类型由 ToolDefinition.execute 约定，透传即可
      execute: async (input: any, options: ToolExecuteOptions) => {
        // Bash 风险检测：dangerous 直接拒绝；moderate 只告警（全拦的话 Agent 干不了活）
        if (tool.name === 'bash') {
          const rejection = this.bashRiskRejection(input)
          if (rejection) return rejection
        }

        // Pre Hook：block 时工具不执行；modify 用改后的输入继续
        let effectiveInput = input
        if (this.hookPipeline) {
          const preResult = await this.hookPipeline.runPre(tool.name, effectiveInput)
          if (preResult.action === 'block') {
            return `[Hook 拦截] ${preResult.reason ?? '操作被阻止'}`
          }
          if (preResult.modifiedInput !== undefined) {
            effectiveInput = preResult.modifiedInput
          }
        }

        // hook 改动过输入就再检一次，避免借 hook 把危险命令送进 bash
        if (tool.name === 'bash' && effectiveInput !== input) {
          const rejection = this.bashRiskRejection(effectiveInput)
          if (rejection) return rejection
        }

        if (isSafe) {
          await this.acquireConcurrent()
        } else {
          await this.acquireExclusive()
        }
        try {
          const raw = await executeFn(effectiveInput, options)
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
          let output = text

          // Post Hook：可替换输出内容
          if (this.hookPipeline) {
            const postResult = await this.hookPipeline.runPost(tool.name, effectiveInput, output)
            if (postResult.modifiedOutput !== undefined) {
              output = String(postResult.modifiedOutput)
            }
          }

          // 截断放在 hook 之后：hook 追加的内容同样受上限约束
          return truncateResult(output, maxChars)
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

  /**
   * 把当前激活的工具转换为 AI SDK 的 ToolSet（延迟且未发现的工具不进入）。
   * 产出后记录引用：searchTools 激活新工具时原地写入，
   * 进行中的 agentLoop（复用同一 ToolSet 对象）后续步骤立即可见。
   */
  toAISDKFormat(): ToolSet {
    const result: Record<string, unknown> = {}
    for (const tool of this.getActiveTools()) {
      result[tool.name] = this.wrapTool(tool)
    }
    this.emittedSet = result
    return result as ToolSet
  }

  /**
   * 复制一份工具目录，锁状态独立。
   * 子 Agent 在 spawn_agent 的 execute 内运行，此时父注册表的独占锁未释放，
   * 直接复用同一个 registry 会在子 Agent 调工具时死锁。
   * 角色、Hook 管线与延迟工具激活状态一并继承；exclude 用于剔除不可用工具。
   */
  fork(options?: { exclude?: Set<string> }): ToolRegistry {
    const forked = new ToolRegistry()
    for (const tool of this.tools.values()) {
      if (!options?.exclude?.has(tool.name)) forked.register(tool)
    }
    forked.currentRole = this.currentRole
    forked.hookPipeline = this.hookPipeline
    forked.discoveredTools = new Set(this.discoveredTools)
    return forked
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
