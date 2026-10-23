## 一个不够就拆成多个——实现 Sub-Agent 机制

为什么拆子 Agent
拆 Agent 有正当理由的场景主要就三个：

上下文装不下了：比如调研三个大项目，单 Agent 上下文累积比较严重
需要并行提效：三个独立任务可以同时跑，不用串行等
需要隔离：子 Agent 做破坏性操作（比如实验性代码重构），不影响主 Agent


## 定义数据结构
新建 src/agents/types.ts，定义子 Agent 的配置和运行状态：

```ts
export interface SubAgentConfig {
  maxSpawnDepth: number;       // 最大嵌套深度，默认 1
  maxConcurrent: number;       // 最大并发子 agent 数，默认 3
  defaultTimeout: number;      // 默认执行超时 ms，默认 60000
}

export const DEFAULT_CONFIG: SubAgentConfig = {
  maxSpawnDepth: 1,
  maxConcurrent: 3,
  defaultTimeout: 60000,
};

export interface SpawnRequest {
  task: string;                // 子 agent 的任务描述
  tools?: string[];            // 允许使用的工具名（不传则继承父 agent）
  timeout?: number;            // 执行超时 ms
}

export interface SubAgentRun {
  id: string;                  // 运行 ID
  task: string;                // 任务描述
  status: 'running' | 'completed' | 'error' | 'timeout';
  depth: number;               // 当前嵌套深度
  startedAt: string;
  finishedAt?: string;
  result?: string;             // 执行结果文本
  error?: string;
}
```

SubAgentRegistry：追踪所有子 Agent
SubAgentRegistry 是个简单的注册表——记录谁在跑、跑到哪了、结果是什么。每次 spawn 前先问它"还能不能派新的子 Agent"。

新建 src/agents/registry.ts：

```ts
import type { SubAgentRun, SubAgentConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export class SubAgentRegistry {
  private runs = new Map<string, SubAgentRun>();
  private config: SubAgentConfig;
  private idCounter = 0;

  constructor(config?: Partial<SubAgentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  generateId(): string {
    return `sub-${++this.idCounter}-${Date.now().toString(36).slice(-4)}`;
  }

  canSpawn(currentDepth: number): { ok: boolean; reason?: string } {
    if (currentDepth >= this.config.maxSpawnDepth) {
      return { ok: false, reason: `已达最大嵌套深度 ${this.config.maxSpawnDepth}` };
    }

    const activeCount = this.getActiveRuns().length;
    if (activeCount >= this.config.maxConcurrent) {
      return { ok: false, reason: `已达最大并发数 ${this.config.maxConcurrent}，等待现有任务完成` };
    }

    return { ok: true };
  }

  register(run: SubAgentRun): void {
    this.runs.set(run.id, run);
  }

  complete(id: string, result: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = 'completed';
    run.result = result;
    run.finishedAt = new Date().toISOString();
  }

  fail(id: string, error: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = 'error';
    run.error = error;
    run.finishedAt = new Date().toISOString();
  }

  get(id: string): SubAgentRun | undefined {
    return this.runs.get(id);
  }

  getActiveRuns(): SubAgentRun[] {
    return Array.from(this.runs.values()).filter(r => r.status === 'running');
  }

  getAllRuns(): SubAgentRun[] {
    return Array.from(this.runs.values());
  }

  getConfig(): SubAgentConfig {
    return this.config;
  }
}
```
canSpawn 用来检查深度和并发数，不满足条件就拒绝创建新的 Agent。这两个检查是 Sub-Agent 系统最基本的安全保障。Claude Code 内部也有类似的限制，只不过它用 token 预算自然收敛，也就是说子 Agent 分到的预算有限，用完了就得收工。

## 核心：spawnAgent 执行隔离
这是整个 Sub-Agent 系统最关键的部分——怎么让子 Agent 在独立上下文里执行。

新建 src/agents/spawn.ts：

```ts
import { type ModelMessage, streamText } from 'ai';
import type { ToolRegistry } from '../tools/registry.js';
import type { SubAgentRegistry } from './registry.js';
import type { SpawnRequest } from './types.js';

export interface SpawnContext {
  model: any;
  registry: ToolRegistry;
  agentRegistry: SubAgentRegistry;
  buildSystem: () => string;
  currentDepth: number;
}

const EXCLUDED_TOOLS = new Set(['spawn_agent']);

const AGENT_COLORS = [
  '\x1b[36m',  // cyan
  '\x1b[33m',  // yellow
  '\x1b[35m',  // magenta
  '\x1b[32m',  // green
  '\x1b[34m',  // blue
];
const RESET = '\x1b[0m';

function agentTag(index: number, runId: string): string {
  const color = AGENT_COLORS[index % AGENT_COLORS.length];
  return `${color}[Agent-${index + 1}:${runId}]${RESET}`;
}

export async function spawnAgent(
  request: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
): Promise<string> {
  const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth);
  if (!ok) return `[spawn] 拒绝: ${reason}`;

  const runId = ctx.agentRegistry.generateId();
  const tag = agentTag(index, runId);
  const run = {
    id: runId,
    task: request.task,
    status: 'running' as const,
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  };
  ctx.agentRegistry.register(run);

  const timeout = request.timeout || 60000;
  const maxSteps = 30;
  const ac = new AbortController();
  console.log(`  ${tag} 启动: ${request.task.slice(0, 50)}`);

  try {
    // 关键：独立的 messages 数组 = 独立的上下文窗口
    const messages: ModelMessage[] = [
      { role: 'user', content: request.task },
    ];
    const system = ctx.buildSystem() +
      '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
      '\n当你需要同时获取多个独立信息时（比如读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具，不要一个个串行调。';

    // toAISDKFormatUnlocked 绕过父 Agent 的读写锁；排除 spawn_agent 防递归
    const tools = ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS);
    const timer = setTimeout(() => ac.abort(), timeout);

    try {
      let step = 0;
      while (step < maxSteps) {
        step++;
        const isLastStep = step === maxSteps;
        console.log(`  ${tag} Step ${step}/${maxSteps}${isLastStep ? ' (总结)' : ''}`);
        if (isLastStep) {
          messages.push({ role: 'user', content: '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。' });
        }
        const result = streamText({
          model: ctx.model, system,
          tools,
          toolChoice: isLastStep ? 'none' : 'auto',
          messages,
          maxRetries: 0, abortSignal: ac.signal,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: () => {},
        });
        let hasToolCall = false;
        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') {
            hasToolCall = true;
            const argsPreview = JSON.stringify(part.input).slice(0, 80);
            console.log(`  ${tag} 调用 ${part.toolName}(${argsPreview})`);
          }
        }
        const response = await result.response;
        messages.push(...response.messages);
        if (!hasToolCall) break;
      }
    } finally {
      clearTimeout(timer);
    }

    // 提取最后一条 assistant 消息作为结果
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    let result = '(无输出)';
    if (lastAssistant) {
      if (typeof lastAssistant.content === 'string') {
        result = lastAssistant.content;
      } else if (Array.isArray(lastAssistant.content)) {
        result = lastAssistant.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('') || '(无输出)';
      }
    }

    ctx.agentRegistry.complete(runId, result);
    console.log(`  ${tag} 完成 ✓ (${result.length} 字符)`);
    return result;
  } catch (err: any) {
    const isAbort = err.name === 'AbortError' || ac.signal.aborted;
    const errorMsg = isAbort ? `执行超时 (${timeout / 1000}s)` : (err.message || String(err));
    ctx.agentRegistry.fail(runId, errorMsg);
    console.log(`  ${tag} ${isAbort ? '超时' : '失败'} ✗: ${errorMsg}`);
    if (isAbort) {
      const partial = [...messages].reverse().find(m => m.role === 'assistant');
      if (partial) {
        const text = typeof partial.content === 'string' ? partial.content
          : Array.isArray(partial.content)
            ? partial.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')
            : '';
        if (text) return `[部分结果] ${text}`;
      }
    }
    return `[sub-agent 执行失败] ${errorMsg}`;
  }
}

export async function spawnParallel(
  requests: SpawnRequest[],
  ctx: SpawnContext,
): Promise<Array<{ task: string; result: string }>> {
  console.log(`\n  ┌─ 派发 ${requests.length} 个子 Agent 并行执行 ─┐`);
  const results = await Promise.all(
    requests.map(async (req, i) => {
      const result = await spawnAgent(req, ctx, i);
      return { task: req.task, result };
    })
  );
  console.log(`  └─ 全部完成 (${results.length}/${requests.length}) ─┘\n`);
  return results;
}

```
这段代码里有几个值得细看的设计决策：

为什么子 Agent 不能直接复用 agentLoop？ 我们之前实现的 agentLoop 内部调的是 registry.toAISDKFormat()，这个方法会走读写锁。但 spawn_agent 本身就是一个工具，执行时父 Agent 的锁还没释放——子 Agent 在里面再调工具就会死锁。所以子 Agent 用 toAISDKFormatUnlocked() 绕过锁，拿到一份独立的工具快照。

EXCLUDED_TOOLS 排除 spawn_agent：子 Agent 的工具列表里不能有 spawn_agent，否则子 Agent 可能再派子 Agent，深度限制虽然能兜底，但从源头排除更干净。

最后一步强制输出文字：子 Agent 跑到第 30 步还在调工具的话，通过 toolChoice: 'none' 显式禁止工具调用，同时注入一条提示消息让模型做总结。双重保障——API 层面禁止了工具调用，prompt 层面引导了输出方向。

彩色 tag：子 Agent 并行执行时终端输出会交错，用 ANSI 颜色前缀区分——Agent-1 cyan、Agent-2 yellow、Agent-3 magenta。

超时保护 AbortController：子 Agent 调网络 API 可能 hang 住，60 秒超时是最后的保底。ac.signal 传给了 streamText，超时后能中断正在进行的 API 请求。超时时还会尝试提取已有的部分结果，不至于完全白跑。

整个隔离机制就在一行代码里：**const messages: ModelMessage[] = [{ role: 'user', content: request.task }]。

子 Agent 拿到的是一个全新的、空的 messages 数组，里面只有一条用户消息——它的任务描述。父 Agent 之前的对话历史、工具调用记录，子 Agent 一概看不到。这就是"独立上下文窗口"的含义——同一个模型、同一套工具，但上下文互不干扰。

子 Agent 执行完后，几万 token 的探索过程全部丢弃，只提取最后一条 assistant 消息作为结果返回。这个压缩比通常在 10 到 20 倍**——子 Agent 读了几十个搜索结果，返回给父 Agent 的可能就一段几百 token 的结论。

spawnParallel 用 Promise.all 并行执行多个子 Agent。三个子 Agent 同时发请求、同时等响应，总耗时约等于最慢的那个，而不是三个的总和。

spawn_agent 工具
把 spawn 能力暴露给模型。模型可以用 task 派一个子 Agent，也可以用 tasks 一次派多个并行执行。

新建 src/tools/spawn-tools.ts：

```ts
import type { ToolDefinition } from './registry.js';
import type { SubAgentRegistry } from '../agents/registry.js';
import { spawnAgent, spawnParallel, type SpawnContext } from '../agents/spawn.js';

export function createSpawnTool(
  agentRegistry: SubAgentRegistry,
  getSpawnCtx: () => SpawnContext,
): ToolDefinition {
  return {
    name: 'spawn_agent',
    description: '派一个子 Agent 去执行任务。子 Agent 有独立的上下文，完成后返回结果摘要。支持同时派多个子 Agent 并行执行。',
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
          description: '多个任务描述，并行执行（与 task 二选一）',
        },
      },
    },
    isConcurrencySafe: false,
    isReadOnly: true,
    execute: async (input: { task?: string; tasks?: string[] }) => {
      const ctx = getSpawnCtx();

      if (input.tasks && input.tasks.length > 0) {
        const requests = input.tasks.map(t => ({ task: t }));
        const results = await spawnParallel(requests, ctx);
        return results.map((r, i) =>
          `## 子 Agent ${i + 1}: ${r.task.slice(0, 40)}\n\n${r.result}`
        ).join('\n\n---\n\n');
      }

      if (input.task) {
        return spawnAgent({ task: input.task }, ctx);
      }

      return '需要提供 task 或 tasks 参数';
    },
  };
}

```
这里有个现实问题：模型不一定会主动用 spawn_agent。如果你同时给了 web_search 和 spawn_agent，模型可能倾向于自己搜索——单 Agent 也能完成任务，只是效率低。

其实 function calling 本身就是最自然的意图检测机制。模型看到工具描述后自行决定调哪个——这和"意图检测"是一回事，只不过检测器是模型自身的推理能力。所以最有效的做法是把工具描述写清楚：在 spawn_agent 的 description 里明确适用场景（"多项独立调研任务、需要并行对比时使用"），同时在 system prompt 里加一句引导（"涉及多个独立目标的调研、对比任务时，优先用 spawn_agent 并行执行"）。这两层加上去，主流模型的命中率已经很高了。


## 接入主流程

```ts
// ... 已有 import ...
import { SubAgentRegistry } from './agents/registry.js';
import { createSpawnTool } from './tools/spawn-tools.js';
import { createAgentCommands } from './commands/agent.js';
import type { SpawnContext } from './agents/spawn.js';

// ... Cron Service 之后 ...

// ── Sub-Agent ────────────────────────────────
const agentRegistry = new SubAgentRegistry({ maxSpawnDepth: 1, maxConcurrent: 3 });

function getSpawnCtx(): SpawnContext {
  return {
    model,
    registry,
    agentRegistry,
    buildSystem: () => builder.build(makePromptCtx()),
    currentDepth: 0,
  };
}

registry.register(createSpawnTool(agentRegistry, getSpawnCtx));

// ... Commands 注册里加一行 ...
...createAgentCommands(agentRegistry),

```

## /agents 查看命令
```ts
import type { CommandHandler } from './index.js';
import type { SubAgentRegistry } from '../agents/registry.js';

export function createAgentCommands(agentRegistry: SubAgentRegistry): CommandHandler[] {
  const handler: CommandHandler = (cmd) => {
    if (!cmd.startsWith('/agents')) return false;

    const runs = agentRegistry.getAllRuns();
    if (runs.length === 0) {
      console.log('  暂无子 Agent 记录');
    } else {
      const active = runs.filter(r => r.status === 'running');
      const completed = runs.filter(r => r.status === 'completed');
      const failed = runs.filter(r => r.status === 'error');

      console.log(`  子 Agent 记录 (${runs.length}):`);
      for (const r of runs) {
        const icon = r.status === 'running' ? '⟳'
          : r.status === 'completed' ? '✓'
          : '✗';
        const detail = r.status === 'completed'
          ? `${r.result?.slice(0, 60)}...`
          : r.status === 'error'
          ? r.error
          : '执行中...';
        console.log(`    ${icon} ${r.id} (depth=${r.depth}) — ${r.task.slice(0, 40)}`);
        console.log(`      ${detail}`);
      }

      const config = agentRegistry.getConfig();
      console.log(`\n  活跃: ${active.length}/${config.maxConcurrent} | 完成: ${completed.length} | 失败: ${failed.length}`);
      console.log(`  最大深度: ${config.maxSpawnDepth} | 最大并发: ${config.maxConcurrent}`);
    }
    return true;
  };

  return [handler];
}

```
## 结果回传
子 Agent 干完活了，结果怎么传回给父 Agent？不同产品选了不同的做法。

我们的实现是最直接的——子 Agent 的输出作为 spawn_agent 工具的返回值，直接注入父 Agent 的上下文。这么做的特点是同步、单向、零延迟。Claude Code 内部也是这个模式。

OpenClaw 做了一层缓冲。它有个 Announce Queue——子 Agent 完成后结果先进队列，有 1 秒的防抖间隔，还有指数退避重试。好处是父 Agent 不会被频繁打断，特别是多个子 Agent 差不多同时完成的时候，防抖的机制能把多个通知合并成一次。

OpenCode 走了分阶段编排的路——阶段 1 最多派 3 个 Explore Agent 并行搜集信息，阶段 2 切回串行，逐步推进。先散后收，跟带团队一样：先让几个人各自去调研，等结果都回来了，再坐下来推进。

我们用同步直接注入，够用而且简单。如果以后你的场景需要异步通知（比如子 Agent 跑了好几分钟才完成），可以考虑接入 Announce Queue 模式。