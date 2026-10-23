## 实现plugin
Plugin 架构——让别人给你的 Agent 写功能，把核心和能力彻底分离，能力通过 Plugin 动态加载。

### src/plugins/types.ts

```ts
import type { ToolDefinition } from '../tools/registry.js';

export interface PluginConfig {
  [key: string]: string | number | boolean;
}

export interface PluginApi {
  registerTools(tools: ToolDefinition[]): void;
  getConfig(): PluginConfig;
  log(message: string): void;
}

export interface PluginDefinition {
  name: string;
  version: string;
  description: string;
  config?: PluginConfig;

  activate(api: PluginApi): Promise<void> | void;
  destroy?(): Promise<void> | void;
}
```

## 实现 PluginManager
PluginManager 的职责很明确：管理 Plugin 的加载/卸载、给每个 Plugin 构造隔离的 PluginApi、处理工具名冲突、保证一个 Plugin 挂掉了不影响其它 Plugin。

### src/plugins/manager.ts

```ts
import type { ToolRegistry, ToolDefinition } from '../tools/registry.js';
import type { PluginDefinition, PluginConfig, PluginApi } from './types.js';

interface LoadedPlugin {
  definition: PluginDefinition;
  tools: string[];
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  async load(definition: PluginDefinition, config?: PluginConfig): Promise<string[]> {
    if (this.plugins.has(definition.name)) {
      throw new Error(`插件 "${definition.name}" 已加载`);
    }

    const resolvedConfig = this.resolveEnvVars({
      ...definition.config,
      ...config,
    });

    const registeredTools: string[] = [];

    const api: PluginApi = {
      registerTools: (tools: ToolDefinition[]) => {
        for (const tool of tools) {
          const prefixedName = `${definition.name}__${tool.name}`;
          const prefixedTool: ToolDefinition = {
            ...tool,
            name: prefixedName,
            description: `[Plugin:${definition.name}] ${tool.description}`,
          };
          this.registry.register(prefixedTool);
          registeredTools.push(prefixedName);
        }
      },
      getConfig: () => resolvedConfig,
      log: (message: string) => {
        console.log(`  [plugin:${definition.name}] ${message}`);
      },
    };

    try {
      await definition.activate(api);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [plugin:${definition.name}] 激活失败: ${msg}`);
      throw err;
    }

    this.plugins.set(definition.name, {
      definition,
      tools: registeredTools,
    });

    return registeredTools;
  }

  async unload(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    if (plugin.definition.destroy) {
      try {
        await plugin.definition.destroy();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [plugin:${name}] destroy 出错: ${msg}`);
      }
    }

    for (const toolName of plugin.tools) {
      this.registry.unregister(toolName);
    }

    this.plugins.delete(name);
    return true;
  }

  async unloadAll(): Promise<void> {
    const names = Array.from(this.plugins.keys());
    for (const name of names) {
      await this.unload(name);
    }
  }

  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  list(): Array<{ name: string; version: string; description: string; tools: string[] }> {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.definition.name,
      version: p.definition.version,
      description: p.definition.description,
      tools: p.tools,
    }));
  }

  private resolveEnvVars(config: PluginConfig): PluginConfig {
    const resolved: PluginConfig = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        const envKey = value.slice(2, -1);
        resolved[key] = process.env[envKey] || '';
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}
```

### 修改src/tools/registry.ts

给 ToolRegistry 加上 unregister 方法，Plugin 卸载时要用

```ts
import { jsonSchema } from 'ai';
import type { MCPClient, MockMCPClient } from './mcp-client.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;
  profile?: string[];
  shouldDefer?: boolean;
  searchHint?: string;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private mcpClients: Array<MCPClient | MockMCPClient> = [];

  private exclusiveLock = false;
  private concurrentCount = 0;
  private waitQueue: Array<() => void> = [];

  private activeProfile: string = 'full';
  private discoveredTools = new Set<string>();

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  unregister(name: string): boolean {
    this.discoveredTools.delete(name);
    return this.tools.delete(name);
  }

  async registerMCPServer(
    serverName: string,
    client: MCPClient | MockMCPClient,
  ): Promise<string[]> {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`;
      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        profile: ['full'],
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        execute: async (input: any) => {
          return toolClient.callTool(originalName, input);
        },
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }

  setProfile(profile: string): void {
    this.activeProfile = profile;
  }

  getProfile(): string {
    return this.activeProfile;
  }

  markDiscovered(name: string): void {
    this.discoveredTools.add(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter(tool => {
      if (tool.profile && !tool.profile.includes(this.activeProfile)) {
        return false;
      }
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      return true;
    });
  }

  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter(tool => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name);
    });

    if (deferred.length === 0) return '';

    const lines = deferred.map(t => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : '';
      return `  - ${t.name}${hint}`;
    });

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`;
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim();
    const results: ToolDefinition[] = [];

    // 支持逗号分隔的多个工具名，如 "mcp__github__list_issues,mcp__github__search_repositories"
    const names = q.includes(',')
      ? q.split(',').map(n => n.trim()).filter(Boolean)
      : [q];

    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool && tool.name !== 'tool_search') {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }

    return results;
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      if (tool.profile && !tool.profile.includes(this.activeProfile)) continue;

      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
      const tokens = Math.ceil(schemaSize / 4);

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return { active, deferred, total: active + deferred };
  }

  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    const activeTools = this.getActiveTools();

    for (const tool of activeTools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          if (isSafe) {
            await registry.acquireConcurrent();
          } else {
            await registry.acquireExclusive();
          }
          try {
            const raw = await executeFn(input);
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
```
### 写一个 Supabase 插件

src/plugins/supabase-plugin.ts 

```ts
import type { PluginDefinition, PluginApi } from './types.js';

export const supabasePlugin: PluginDefinition = {
  name: 'supabase',
  version: '1.0.0',
  description: '提供 Supabase 数据库操作能力（query / insert / list_tables）',
  config: {
    supabaseUrl: '${SUPABASE_URL}',
    supabaseKey: '${SUPABASE_KEY}',
  },

  activate(api: PluginApi) {
    const config = api.getConfig();
    const url = config.supabaseUrl as string;
    const key = config.supabaseKey as string;

    if (!url || !key) {
      api.log('未配置 SUPABASE_URL / SUPABASE_KEY，使用 Mock 模式');
    }

    api.registerTools([
      {
        name: 'list_tables',
        description: '列出数据库中所有表',
        parameters: { type: 'object', properties: {}, required: [] },
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async () => {
          if (!url) {
            return JSON.stringify({
              tables: ['users', 'posts', 'comments', 'sessions'],
              note: 'Mock 模式 — 配置 SUPABASE_URL 和 SUPABASE_KEY 连接真实数据库',
            });
          }
          return `连接 ${url} 查询表列表...（真实实现会调用 Supabase API）`;
        },
      },
      {
        name: 'query',
        description: '查询指定表的数据，支持 select / where / limit',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: '表名' },
            select: { type: 'string', description: '查询字段，默认 *' },
            where: { type: 'string', description: '过滤条件，如 status=active' },
            limit: { type: 'number', description: '返回条数限制，默认 10' },
          },
          required: ['table'],
        },
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async (input: { table: string; select?: string; where?: string; limit?: number }) => {
          const { table, select = '*', where, limit = 10 } = input;
          if (!url) {
            const mockData: Record<string, any[]> = {
              users: [
                { id: 1, name: '张三', email: 'zhang@example.com', role: 'admin' },
                { id: 2, name: '李四', email: 'li@example.com', role: 'user' },
                { id: 3, name: '王五', email: 'wang@example.com', role: 'user' },
              ],
              posts: [
                { id: 1, title: 'Agent 开发入门', author_id: 1, status: 'published' },
                { id: 2, title: 'Plugin 架构设计', author_id: 1, status: 'draft' },
              ],
              comments: [
                { id: 1, post_id: 1, user_id: 2, content: '写得不错！' },
              ],
              sessions: [
                { id: 'sess-001', user_id: 1, created_at: '2026-05-01T10:00:00Z' },
              ],
            };
            const rows = mockData[table] || [];
            let filtered = rows;
            if (where) {
              const [field, value] = where.split('=');
              filtered = rows.filter(r => String(r[field]) === value);
            }
            return JSON.stringify({ table, rows: filtered.slice(0, limit), total: filtered.length });
          }
          return `SELECT ${select} FROM ${table}${where ? ` WHERE ${where}` : ''} LIMIT ${limit}`;
        },
      },
      {
        name: 'insert',
        description: '向指定表插入一条记录',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: '表名' },
            data: { type: 'object', description: '要插入的数据' },
          },
          required: ['table', 'data'],
        },
        isConcurrencySafe: false,
        isReadOnly: false,
        execute: async (input: { table: string; data: Record<string, unknown> }) => {
          const { table, data } = input;
          if (!url) {
            return JSON.stringify({
              success: true,
              table,
              inserted: { id: Math.floor(Math.random() * 1000), ...data },
              note: 'Mock 模式',
            });
          }
          return `INSERT INTO ${table} — ${JSON.stringify(data)}`;
        },
      },
    ]);

    api.log(`已注册 3 个工具（list_tables / query / insert）`);
  },

  destroy() {
    console.log('  [plugin:supabase] 连接已释放');
  },
};
```

## 管理后台插件管理

参考

```ts
import type { CommandHandler } from './index.js';
import type { PluginManager } from '../plugins/manager.js';
import type { PluginDefinition } from '../plugins/types.js';

export function createPluginCommands(
  pluginManager: PluginManager,
  availablePlugins: Map<string, PluginDefinition>,
): CommandHandler[] {
  return [
    // /plugin 或 /plugin list
    (cmd, _ctx) => {
      if (cmd !== '/plugin' && cmd !== '/plugin list') return false;

      const loaded = pluginManager.list();
      const unloaded = Array.from(availablePlugins.entries())
        .filter(([name]) => !loaded.find(p => p.name === name));

      if (loaded.length === 0 && unloaded.length === 0) {
        console.log('\n[plugins] 没有可用的插件。\n');
        return true;
      }

      console.log('\n[plugins]');
      if (loaded.length > 0) {
        console.log('  已加载：');
        for (const p of loaded) {
          console.log(`    ${p.name} v${p.version} — ${p.description}`);
          console.log(`      工具: ${p.tools.join(', ')}`);
        }
      }
      if (unloaded.length > 0) {
        console.log('  可加载：');
        for (const [name, def] of unloaded) {
          console.log(`    ${name} v${def.version} — ${def.description}`);
        }
      }
      console.log('');
      return true;
    },

    // /plugin load <name>
    (cmd, _ctx) => {
      const match = cmd.match(/^\/plugin\s+load\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];

      const def = availablePlugins.get(name);
      if (!def) {
        console.log(`\n[plugins] 找不到插件: ${name}\n`);
        return true;
      }

      if (pluginManager.get(name)) {
        console.log(`\n[plugins] ${name} 已经加载了\n`);
        return true;
      }

      pluginManager.load(def).then(tools => {
        console.log(`\n[plugins] 已加载 ${name}，注册了 ${tools.length} 个工具：`);
        for (const t of tools) console.log(`    ${t}`);
        console.log('');
      }).catch(err => {
        console.log(`\n[plugins] 加载 ${name} 失败: ${err.message}\n`);
      });

      return true;
    },

    // /plugin unload <name>
    (cmd, _ctx) => {
      const match = cmd.match(/^\/plugin\s+unload\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];

      pluginManager.unload(name).then(ok => {
        if (ok) {
          console.log(`\n[plugins] 已卸载 ${name}，相关工具已移除\n`);
        } else {
          console.log(`\n[plugins] ${name} 未加载\n`);
        }
      });

      return true;
    },
  ];
}
```

## 插件加载到主流程，打印日志参考

```
// 在 import 区域新增：
import { PluginManager } from './plugins/manager.js';
import { supabasePlugin } from './plugins/supabase-plugin.js';
import { createPluginCommands } from './commands/plugin.js';
import type { PluginDefinition } from './plugins/types.js';

// ── Plugins ────────────────────────────────
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([
  ['supabase', supabasePlugin],
]);

// Commands 里注册 plugin 命令
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...ragCommands,
  ...dreamCommands,
  ...createSkillCommands(skillLoader, activeSkills),
  ...createPluginCommands(pluginManager, availablePlugins),
]);

// main() 里启动时加载插件
console.log('  加载插件...');
for (const [name, def] of availablePlugins) {
  try {
    const tools = await pluginManager.load(def);
    console.log(`  ✓ ${name} — ${tools.length} 个工具`);
  } catch {
    console.log(`  ✗ ${name} — 加载失败`);
  }
}

// 退出时 Graceful Shutdown
if (!trimmed || trimmed === 'exit') {
  console.log('Bye!');
  await pluginManager.unloadAll();  // ← 清理所有插件资源
  rl.close();
  return;
}

```