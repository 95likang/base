## 配置系统

从硬编码到配置文件, 下面代码是参考代码，实现要按照现在项目的来。
翻一下现在的 index.ts，硬编码的地方偏多，模型地址、模型名、子 Agent 参数、飞书端口、插件列表、Cron 数据目录……每改一个都要动代码、重新部署。

我们要做的是定义一个 JSON 配置文件，把所有可调参数集中管理。读取的时候做三件事：

Zod 校验：确保配置合法，写错了直接报错并告诉你哪个字段有问题
环境变量替换：配置里写 ${DASHSCOPE_API_KEY}，运行时自动从 .env 或系统环境变量读取，敏感信息不硬编码
默认值合并：配置文件只需要写"跟默认不一样的部分"，其他全部自动填充

配置 Schema
新建 src/config/schema.ts，用 Zod 定义配置结构：

```ts
import { z } from 'zod';

export const ModelConfigSchema = z.object({
  provider: z.enum(['dashscope', 'openai', 'custom']).default('dashscope'),
  name: z.string().default('qwen-plus-latest'),
  baseURL: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  apiKey: z.string().default(''),
});

export const PluginConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.string()).default({}),
});

export const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  port: z.number().default(3000),
});

export const ChannelConfigSchema = z.object({
  feishu: FeishuChannelConfigSchema.default({}),
});

export const AgentConfigSchema = z.object({
  maxSpawnDepth: z.number().min(0).max(5).default(1),
  maxConcurrent: z.number().min(1).max(10).default(3),
  defaultTimeout: z.number().default(60000),
});

export const SecurityConfigSchema = z.object({
  defaultRole: z.string().default('developer'),
  auditLog: z.boolean().default(true),
  bashTimestamp: z.boolean().default(true),
});

export const MemoryConfigSchema = z.object({
  dataDir: z.string().default('.'),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  docsDir: z.string().default('docs'),
});

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default('.'),
});

export const SessionConfigSchema = z.object({
  id: z.string().default('default'),
});

export const UsageConfigSchema = z.object({
  trackingFile: z.string().default('.usage/today.jsonl'),
});

export const SuperAgentConfigSchema = z.object({
  version: z.string().default('1.0'),
  model: ModelConfigSchema.default({}),
  plugins: z.array(PluginConfigSchema).default([]),
  channels: ChannelConfigSchema.default({}),
  agents: AgentConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  rag: RagConfigSchema.default({}),
  cron: CronConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  usage: UsageConfigSchema.default({}),
});

export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;

```
注意每个字段都有 .default() —— 这意味着用户可以只写一个空的 {}，Zod 会把所有默认值都填上。想改什么就写什么，其余的自动用默认值。这就是配置最小化原则：配置文件只表达"跟默认不一样的意图"。

OpenClaw 的配置系统也是这个思路，它用了大约 200 个 Zod schema 覆盖所有子系统。我们的配置项规模小得多，但核心模式是一样的。

ConfigLoader：读取、替换、校验
新建 src/config/loader.ts：

```ts
import fs from 'node:fs';
import { SuperAgentConfigSchema, type SuperAgentConfig } from './schema.js';

export const CONFIG_FILE = 'super-agent.config.json';

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(ENV_VAR_RE, (match, name) => {
      const val = process.env[name];
      if (val === undefined) {
        console.warn(`  ⚠ 环境变量 ${name} 未设置，保留原值`);
        return match;
      }
      return val;
    });
  }
  if (Array.isArray(obj)) return obj.map(substituteEnvVars);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(path = CONFIG_FILE): SuperAgentConfig {
  if (!fs.existsSync(path)) {
    console.log(`  未找到 ${path}，使用默认配置`);
    console.log('  运行 pnpm run init 生成配置文件\n');
    return SuperAgentConfigSchema.parse({});
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`  ✗ 解析 ${path} 失败: ${(err as Error).message}`);
    process.exit(1);
  }

  const substituted = substituteEnvVars(raw);

  const result = SuperAgentConfigSchema.safeParse(substituted);
  if (!result.success) {
    console.error('  ✗ 配置文件校验失败:');
    for (const issue of result.error.issues) {
      console.error(`    ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  console.log(`  ✓ 已加载 ${path}`);
  return result.data;
}

```
loadConfig 做了下面这四件事情，顺序很重要：

读取 JSON → 替换 ${ENV_VAR} → Zod 校验 + 默认值合并

环境变量替换发生在 Zod 校验之前。这意味着你可以在配置文件里写 "apiKey": "${DASHSCOPE_API_KEY}"，运行时自动从环境变量读取实际值。敏感信息（API Key、Secret）不会出现在配置文件里，但配置文件本身依然是完整可读的。

substituteEnvVars 只匹配大写字母+下划线的模式（[A-Z_][A-Z0-9_]*），这是 OpenClaw 也在用的约定——环境变量统一大写，避免误替换正常文本中的 ${} 模式。

如果配置校验失败，safeParse 返回详细的错误路径和原因，直接打印出来告诉用户哪里写错了


init 引导命令
用户第一次用 Super Agent，不应该让他手动写 JSON。一个交互式的 init 命令能引导用户走完所有关键配置。

新建 src/config/init.ts：


```ts
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { CONFIG_FILE } from './loader.js';

export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => {
      console.log(q);
      rl.question('  > ', resolve);
    });

  console.log('\n  Super Agent 初始化向导\n');

  if (fs.existsSync(CONFIG_FILE)) {
    const overwrite = await ask(`  ${CONFIG_FILE} 已存在，覆盖? (y/N): `);
    if (overwrite.toLowerCase() !== 'y') {
      console.log('  已取消\n');
      rl.close();
      return;
    }
  }

  // ── 模型选择 ──────────────────────────
  console.log('  选择模型:\n');
  console.log('    1. qwen-plus-latest   (推荐，均衡)');
  console.log('    2. qwen-turbo-latest  (快速，便宜)');
  console.log('    3. qwen-max-latest    (最强，贵)\n');
  const modelChoice = (await ask('  模型 [1]: ')) || '1';
  const models: Record<string, string> = {
    '1': 'qwen-plus-latest',
    '2': 'qwen-turbo-latest',
    '3': 'qwen-max-latest',
  };
  const modelName = models[modelChoice] || 'qwen-plus-latest';

  // ── API Key ──────────────────────────
  const apiKey = await ask('\n  DashScope API Key (留空则从环境变量 DASHSCOPE_API_KEY 读取): ');

  // ── 飞书 Channel ──────────────────────────
  const enableFeishu = (await ask('\n  启用飞书 Channel? (y/N): ')).toLowerCase() === 'y';
  let feishuAppId = '';
  let feishuAppSecret = '';
  if (enableFeishu) {
    feishuAppId = await ask('  飞书 App ID: ');
    feishuAppSecret = await ask('  飞书 App Secret: ');
  }

  // ── Sub-Agent ──────────────────────────
  const concurrentStr = await ask('\n  子 Agent 最大并发数 [3]: ');
  const maxConcurrent = parseInt(concurrentStr) || 3;

  // ── 生成配置 ──────────────────────────
  const config = {
    version: '1.0',
    model: {
      provider: 'dashscope',
      name: modelName,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: apiKey || '${DASHSCOPE_API_KEY}',
    },
    plugins: [
      { name: 'supabase', enabled: false, config: {} },
    ],
    channels: {
      feishu: {
        enabled: enableFeishu,
        appId: enableFeishu ? feishuAppId : '${FEISHU_APP_ID}',
        appSecret: enableFeishu ? feishuAppSecret : '${FEISHU_APP_SECRET}',
        port: 3000,
      },
    },
    agents: {
      maxSpawnDepth: 1,
      maxConcurrent,
      defaultTimeout: 60000,
    },
    security: {
      defaultRole: 'developer',
      auditLog: true,
      bashTimestamp: true,
    },
    memory: { dataDir: '.' },
    rag: { enabled: true, docsDir: 'docs' },
    cron: { enabled: true, dataDir: '.' },
    session: { id: 'default' },
    usage: { trackingFile: '.usage/today.jsonl' },
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  console.log(`\n  ✓ ${CONFIG_FILE} 已生成`);

  // 生成 .env
  const envLines: string[] = [];
  if (apiKey) {
    envLines.push(`DASHSCOPE_API_KEY=${apiKey}`);
  }
  if (enableFeishu && feishuAppId) {
    envLines.push(`FEISHU_APP_ID=${feishuAppId}`);
    envLines.push(`FEISHU_APP_SECRET=${feishuAppSecret}`);
  }
  if (envLines.length > 0) {
    fs.writeFileSync('.env', envLines.join('\n') + '\n');
    console.log('  ✓ .env 已生成');
  }

  console.log('\n  启动 Agent: pnpm start\n');
  rl.close();
}

```
init 生成两个文件：super-agent.config.json 和 .env。API Key 如果用户直接输入了就写进 .env，配置文件里用 ${DASHSCOPE_API_KEY} 引用。飞书的 App ID 和 App Secret 同理。


## CLI 入口
现在 index.ts 需要根据命令行参数决定跑 init 还是 start。

把原来 index.ts 里的所有启动逻辑搬到 src/main.ts，index.ts 只做路由：

```ts
const command = process.argv[2];

if (command === 'init') {
  import('./config/init.js').then(m => m.runInit());
} else {
  import('./main.js').then(m => m.startAgent().catch(console.error));
}

```

然后 package.json 加上对应的 scripts：

```ts
{
  "name": "super-agent",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "super-agent": "src/index.ts"
  },
  "scripts": {
    "start": "tsx src/index.ts",
    "init": "tsx src/index.ts init",
    "continue": "tsx src/index.ts --continue"
  }
}

```

## 配置驱动初始化
src/main.ts 是重构后的主入口。最大的变化是：所有硬编码都被 config 对象替代。


之前模型创建是这样的：

```ts
const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});
const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel();

```

现在变成了：

```ts
function createModel(cfg: SuperAgentConfig['model']) {
  if (!cfg.apiKey) return createMockModel();
  const provider = createOpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  return provider.chat(cfg.name);
}
const model = createModel(config.model);

```
模型名、API 地址、API Key 全从配置来读取。如果想换成 qwen-max-latest，改配置文件就行，不动代码。

子 Agent 配置也一样：

```ts
// 之前
const agentRegistry = new SubAgentRegistry({ maxSpawnDepth: 1, maxConcurrent: 3 });

// 现在
const agentRegistry = new SubAgentRegistry({
  maxSpawnDepth: config.agents.maxSpawnDepth,
  maxConcurrent: config.agents.maxConcurrent,
});

```
飞书 Channel 变成了条件启用：

```ts
if (config.channels.feishu.enabled) {
  const feishuChannel = new FeishuChannel({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
    port: config.channels.feishu.port,
  });
  gateway.register(feishuChannel);
}

```
配置文件里 "feishu": { "enabled": false } 就完全跳过飞书初始化——不创建实例、不启动 HTTP 服务。之前不管用不用飞书，都会创建 FeishuChannel 实例并启动一个 HTTP 服务在那占着端口。

之前做过的安全相关的 Hook 也是配置驱动：


```ts
if (config.security.auditLog) {
  hookPipeline.registerPre('audit-log', ...);
}
if (config.security.bashTimestamp) {
  hookPipeline.registerPost('bash-timestamp', ...);
}

```

插件加载也从"全部加载"变成了"按配置启用"：

```ts
for (const pluginCfg of config.plugins) {
  const def = availablePlugins.get(pluginCfg.name);
  if (!def) { console.log(`  ✗ ${pluginCfg.name} — 未知插件`); continue; }
  if (!pluginCfg.enabled) { console.log(`  - ${pluginCfg.name} — 已禁用`); continue; }
  const tools = await pluginManager.load(def);
  console.log(`  ✓ ${pluginCfg.name} — ${tools.length} 个工具`);
}

```
Cron 和 RAG 同理，都有 config.cron.enabled 和 config.rag.enabled 的开关。配置里关掉了，对应的子系统完全不初始化。

main.ts 的完整代码可以在右侧编辑器里查看——本质上就是把上一节的 index.ts 搬过来，所有硬编码替换成 config.xxx 读取，再给各个子系统加上条件开关。

整个 main.ts 的初始化流程就是按配置逐个初始化子系统。回头看一下我们从头到尾造了多少东西：

每一块的参数都从 super-agent.config.json 读取，配置化的真正价值在于让运维和使用者不需要理解代码就能调整行为。
