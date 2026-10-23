## 把 Agent 的每一步留下来——本地 Trace 与执行复盘

Agent 最后给了一个不靠谱的结论。你看到的只有最终回答，却不知道中间发生了什么：

第一步送给模型的上下文到底有哪些？
模型为什么选择了 grep，没有先读 package.json？
工具返回了什么，结果有没有被截断？
哪一步开始跑偏？
这次任务用了多少 token、跑了多久、有没有重试？
普通日志只能告诉你「程序运行过」，却很难还原 Agent 的决策现场。我们需要的是一份 Trace：从任务开始到结束，把 Agent Loop 每个 Step 的输入上下文和输出结果按顺序留下来。

这一节我们不接任何第三方平台，先做一个最小但完整的本地方案：一个任务生成一个 JSONL Trace 文件。

Trace 和 Session 日志不是一回事
我们在第 7 节已经做过 Session 持久化。Session 保存的是对话历史，目标是让用户关掉终端以后还能接着聊。

Trace 解决的是另一个问题：复盘一次执行为什么得到这个结果。

对比	Session	Trace
服务对象	用户继续对话	开发者排查与复盘
核心内容	user / assistant / tool 消息	每个 Step 的完整输入、输出、耗时、usage、错误
组织方式	一个会话持续追加	一次 Agent 任务一个文件
生命周期	可以长期存在	通常按天数清理或归档
最容易漏掉的字段是 Step 开始前的上下文快照。

只保存模型输出不够。假设 Step 4 回答错了，真正的原因可能是 Step 4 收到的上下文里，早期工具结果已经被压缩掉，或者一条错误信息被当成了可靠事实。没有输入快照，你只能看到结果错了，却看不到它是在什么信息条件下做出的决定。

所以我们的每个 Step 至少记录两类事件：

text


step_started   → 模型调用前：system + messages
step_completed → 模型调用后：新增消息 + 文本 + usage + 耗时
如果请求失败或触发重试，再插入一条 step_attempt_failed。整个任务的头尾分别是 trace_started 和 trace_finished。

## 为什么选 JSONL
JSONL 就是「一行一个 JSON 对象」。它看起来像这样：

json

```ts
{"type":"trace_started","traceId":"default-2026-08-05T10-20-30-000Z"}
{"type":"step_started","step":1,"context":{"system":"...","messages":[]}}
{"type":"step_completed","step":1,"durationMs":842,"usage":{"inputTokens":1520,"outputTokens":96}}
{"type":"trace_finished","status":"completed","durationMs":1834}
```
这里没有把整个 Trace 写成一个巨大的 JSON 数组，原因有三个：

边跑边写：每完成一个事件就追加一行，不用把整条 Trace 放在内存里；
中断可恢复：进程在 Step 8 崩了，前 7 步仍然是合法记录；
容易迁移：以后上传对象存储、导入日志系统或逐行处理都很方便。
它的代价是读取时需要逐行解析，但对调试工具来说，这点成本几乎可以忽略。

第一步：实现 LocalTraceRecorder
新建 src/trace/recorder.ts。这个类只负责一件事：把结构化事件追加到当前 Trace 文件。

```ts
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelMessage } from 'ai';
import type { StepUsage } from '../usage/tracker.js';

type TraceStatus = 'completed' | 'failed' | 'cancelled';

interface TraceOptions {
  directory?: string;
  sessionId: string;
  model: string;
}

interface StepStartedInput {
  step: number;
  system: string;
  messages: ModelMessage[];
}

interface StepCompletedInput {
  step: number;
  text: string;
  outputMessages: ModelMessage[];
  usage: StepUsage;
}

const SECRET_KEY = /api[-_]?key|token|secret|password|authorization/i;

function sanitize(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]),
    );
  }
  return value;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'default';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalTraceRecorder {
  readonly traceId: string;
  readonly filePath: string;
  private readonly startedAt = Date.now();
  private readonly stepStartedAt = new Map<number, number>();
  private writeFailed = false;

  private constructor(private readonly options: TraceOptions) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.traceId = `${safeName(options.sessionId)}-${stamp}`;
    this.filePath = join(options.directory ?? '.traces', `${this.traceId}.jsonl`);
  }

  static async start(options: TraceOptions): Promise<LocalTraceRecorder> {
    const recorder = new LocalTraceRecorder(options);
    await mkdir(dirname(recorder.filePath), { recursive: true });
    await recorder.write({
      type: 'trace_started',
      traceId: recorder.traceId,
      sessionId: options.sessionId,
      model: options.model,
      timestamp: new Date().toISOString(),
    });
    return recorder;
  }

  async recordStepStarted(input: StepStartedInput): Promise<void> {
    this.stepStartedAt.set(input.step, Date.now());
    await this.write({
      type: 'step_started',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      context: sanitize({ system: input.system, messages: input.messages }),
    });
  }

  async recordAttemptError(step: number, attempt: number, error: unknown): Promise<void> {
    await this.write({
      type: 'step_attempt_failed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step,
      attempt,
      error: errorMessage(error),
    });
  }

  async recordStepCompleted(input: StepCompletedInput): Promise<void> {
    const startedAt = this.stepStartedAt.get(input.step) ?? Date.now();
    await this.write({
      type: 'step_completed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      durationMs: Date.now() - startedAt,
      output: sanitize({ text: input.text, messages: input.outputMessages }),
      usage: input.usage,
    });
  }

  async finish(status: TraceStatus, error?: unknown): Promise<void> {
    await this.write({
      type: 'trace_finished',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      status,
      durationMs: Date.now() - this.startedAt,
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    });
  }

  private async write(event: Record<string, unknown>): Promise<void> {
    if (this.writeFailed) return;
    try {
      await appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf8');
    } catch (error) {
      this.writeFailed = true;
      console.warn(`  [Trace] 写入失败，已停止记录: ${errorMessage(error)}`);
    }
  }
}

```

这里有几个细节值得说一下。

一个任务一个 Trace ID
Trace ID 由 sessionId + 时间戳 组成。Session ID 帮你定位这次任务属于哪个会话，时间戳保证同一会话里的每次任务都生成独立文件。

先做基础脱敏
上下文里可能出现 API Key、Token、密码。示例用字段名做了一层递归脱敏，命中 apiKey、token、secret、password、authorization 的值都会变成 [REDACTED]。

第二步：在 Agent Loop 的边界打点
Recorder 写好了，接下来要决定在哪里调用它。

不要在工具内部各写一套 Trace。Agent Loop 才是最稳定的边界：每个 Step 一定从这里开始，也一定在这里拿到模型响应和 usage。工具调用已经包含在 stepResponse.messages 中，不需要自己再造一份。

修改 src/agent/loop.ts，先把 Recorder 作为可选参数传进来：

```ts
import type { LocalTraceRecorder } from '../trace/recorder.js';

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  tracker?: UsageTracker,
  tag?: string,
  maxSteps?: number,
  signal?: AbortSignal,
  trace?: LocalTraceRecorder,
) {
  // 原有实现保持不变
}

```

然后在每一轮调用模型之前记录输入上下文：
```ts
while (step < stepLimit) {
  step++;

  await trace?.recordStepStarted({ step, system, messages });

  // 接下来才调用 streamText(...)
}

```
这个顺序不能反。如果等模型返回以后才保存 messages，数组可能已经追加了新消息，你记录到的就不是「模型当时看到的上下文」，而是执行后的状态。

当请求失败时，把每一次尝试也留下来：

```ts
} catch (error) {
  await trace?.recordAttemptError(step, attempt, error);
  if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;

  const delay = calculateDelay(attempt);
  console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次，${delay}ms 后...`);
  await sleep(delay);
}

```

最后，在拿到模型的 response 和 usage、并完成 token 规范化之后，记录 Step 的结果：

```ts
const norm = normalizeUsage(stepUsage, {
  provider: model?.provider,
  providerMetadata: stepProviderMetadata,
});

await trace?.recordStepCompleted({
  step,
  text: fullText,
  outputMessages: stepResponse.messages,
  usage: norm,
});

```
现在一个 Step 的上下文、工具调用、工具结果、模型文字、token 和耗时都串起来了。

## 第三步：一次用户任务创建一条 Trace
Recorder 不应该在 Agent 启动时只创建一次，否则一天里所有用户任务都会混在同一个大文件里。更好的粒度是：用户每发起一次任务，就创建一条 Trace。

修改 src/main.ts 中调用 agentLoop 的位置：

```ts
const trace = await LocalTraceRecorder.start({
  sessionId: config.session.id,
  model: model?.modelId || config.model.name,
});

try {
  await agentLoop(
    model,
    registry,
    messages,
    currentSystem,
    tracker,
    undefined,
    undefined,
    undefined,
    trace,
  );
  await trace.finish('completed');
  console.log(`  [Trace] ${trace.filePath}`);
} catch (error) {
  await trace.finish('failed', error);
  console.error(`  [Agent] ${error instanceof Error ? error.message : String(error)}`);
  ask();
  return;
}

```
trace_finished 很重要。没有它时，我们依然能读取前面的 Step，但可以明确判断这条 Trace 是完整结束，还是进程中途退出。

在多入口系统里，CLI、飞书、Cron Job、Sub-Agent 都可以创建自己的 Trace。你还可以给 Recorder 加 parentTraceId，把子 Agent 的 Trace 和父 Agent 串成一棵树。我们这一节先只接 CLI 主链路，把最小闭环跑通。

最后把 Trace 目录加进 .gitignore

## 第四步：写一个最小复盘命令
原始 JSONL 证据最完整，但肉眼看几百行 JSON 不舒服。我们给 Recorder 文件加一个 inspectTrace 函数：逐行读事件，只提取 Step、耗时、token 和工具名。

课程完整代码已经包含这段实现。再新建 src/trace/inspect.ts 作为命令入口：


```ts
import { inspectTrace } from './recorder.js';

const filePath = process.argv[2];

if (!filePath) {
  console.error('用法: pnpm trace:inspect <trace-file>');
  process.exit(1);
}

console.log(await inspectTrace(filePath));

```
在 package.json 增加脚本：
```ts
{
  "scripts": {
    "trace:inspect": "tsx src/trace/inspect.ts"
  }
}

```


## 别让 Trace 无限长大
本地方案跑起来以后，还要补三个生产约束。

第一是 保留周期。Trace 很占空间，尤其我们保存了每个 Step 的完整上下文，同一批历史消息会重复出现。开发环境可以保留 7 天，生产环境根据排障和合规要求设置 7～30 天，然后定时清理或归档。

第二是 大小上限。工具可能返回很大的文件，图片也可能以 Base64 出现在消息里。生产版应该对单个字段和单条 Trace 设置大小上限，把大对象改成引用：

```ts
{
  "contentType": "image/png",
  "size": 2841932,
  "storageUrl": "..."
}

```
