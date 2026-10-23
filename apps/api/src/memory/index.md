## 记忆为什么会坏

失效模式的理论分析，这里快速过一遍，然后聚焦在工程实现上。其实就四种方式：

污染——把推测当事实存了。Agent 看到旧的 MySQL 配置文件就存下"项目用 MySQL"，实际上早迁到 PostgreSQL 了。

爆炸——只存不删，信噪比越来越低。500 条记忆里挑 5 条相关的，搜出来基本没用。

过期——代码变了记忆没跟上。这是最隐蔽也最危险的——Agent 不会怀疑自己的记忆，它会基于错误信息做出自信的错误决策。

冲突——新旧记忆互相矛盾。旧记忆说"不要写注释"，新记忆说"关键逻辑要加注释"。Agent 不知道信谁，行为会漂移。

这四种问题，我们接下来用三层手段分别应对：

不存清单解决污染——从源头控制别让垃圾进来；
lint + TTL 分级解决过期和爆炸——定期扫描，按类型判断该不该淘汰；
dream 自动整理解决冲突和残留——让 Agent 自己合并重复、清理垃圾。

对付污染最有效的方法，不是存完再检测，而是从一开始就别让垃圾进来。

Claude Code 的记忆系统就有一份明确的"不存清单"：

- 代码能推导的不存：项目用什么语言、什么框架、目录结构——读代码就知道
- git 能查的不存：谁改了什么、最近有哪些 PR——git log 是原始的数据源
- 文档已经写了的不存：CLAUDE.md 里的约定每次对话都会加载，重复存制造冲突
- 临时性的不存：当前任务上下文、debug 中的发现——会话结束就没用了

提示词

```ts
import fs from 'node:fs';
import path from 'node:path';
import { bm25Search, type SearchHit } from './search.js';
import { lintAll, type ValidationReport } from './validator.js';

export interface MemoryEntry {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  content: string;
  filePath: string;
  lastWriteAt?: number;
  lastReadAt?: number;
}

const MEMORY_DIR = '.memory';
const INDEX_FILE = 'MEMORY.md';
const MAX_INDEX_LINES = 200;
const MAX_FILE_CHARS = 4000;
const STALE_DAYS = 30;

export class MemoryStore {
  private readonly baseDir: string;

  constructor(baseDir: string = '.') {
    this.baseDir = baseDir;
  }

  private get memoryDir(): string {
    return path.join(this.baseDir, MEMORY_DIR);
  }

  private get indexPath(): string {
    return path.join(this.memoryDir, INDEX_FILE);
  }

  init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, '# Memory Index\n', 'utf-8');
    }
  }

  save(entry: Omit<MemoryEntry, 'filePath' | 'lastWriteAt' | 'lastReadAt'>): string {
    this.init();
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '');
    const filename = `${entry.type}_${slug}.md`;
    const filePath = path.join(this.memoryDir, filename);
    const now = Date.now();

    const fileContent = [
      '---',
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      `lastWriteAt: ${now}`,
      `lastReadAt: ${now}`,
      '---',
      '',
      entry.content,
    ].join('\n');

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    this.updateIndex(entry.name, filename, entry.description);
    return filename;
  }

  private updateIndex(name: string, filename: string, description: string): void {
    const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
    const lines = indexContent.split('\n');

    const existingIdx = lines.findIndex(l => l.includes(`(${filename})`));
    const newLine = `- [${name}](${filename}) — ${description}`;

    if (existingIdx >= 0) {
      lines[existingIdx] = newLine;
    } else {
      if (lines.length >= MAX_INDEX_LINES) {
        console.log(`[memory] 索引已达 ${MAX_INDEX_LINES} 行上限，移除最早的条目`);
        const firstEntry = lines.findIndex(l => l.startsWith('- '));
        if (firstEntry >= 0) lines.splice(firstEntry, 1);
      }
      lines.push(newLine);
    }

    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
  }

  list(): MemoryEntry[] {
    this.init();
    const entries: MemoryEntry[] = [];
    const files = fs.readdirSync(this.memoryDir)
      .filter(f => f.endsWith('.md') && f !== INDEX_FILE);

    for (const file of files) {
      const filePath = path.join(this.memoryDir, file);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = this.parseFrontmatter(raw);
      if (parsed) {
        entries.push({ ...parsed, filePath });
      }
    }
    return entries;
  }

  search(query: string, topK = 5): SearchHit[] {
    return bm25Search(this.list(), query, topK);
  }

  loadIndex(): string {
    this.init();
    const raw = fs.readFileSync(this.indexPath, 'utf-8');
    return raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)' : raw;
  }

  loadFile(filename: string): string | null {
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return null;
    this.touchReadAt(filename);
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)' : raw;
  }

  private touchReadAt(filename: string): void {
    const filePath = path.join(this.memoryDir, filename);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const now = Date.now();
    let updated: string;
    if (/^lastReadAt:.*$/m.test(raw)) {
      updated = raw.replace(/^lastReadAt:.*$/m, `lastReadAt: ${now}`);
    } else {
      updated = raw.replace(/^---\n/, `---\nlastReadAt: ${now}\n`);
    }
    fs.writeFileSync(filePath, updated, 'utf-8');
  }

  delete(filename: string): boolean {
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);

    const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
    const lines = indexContent.split('\n').filter(l => !l.includes(`(${filename})`));
    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
    return true;
  }

  lint(): ValidationReport[] {
    return lintAll(this.list(), this.baseDir);
  }

  buildPromptSection(): string {
    this.init();
    const index = this.loadIndex();
    const entries = this.list();

    if (entries.length === 0) {
      return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。';
    }

    const lines = [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      '',
      '记忆索引：',
      index,
      '',
      '使用 memory 工具的 read 操作来读取具体记忆内容；用 search 做 BM25 搜索；用 lint 检查记忆库健康度。',
      '',
      '记忆使用原则：',
      '- 记忆是线索，不是事实——使用前先用工具验证（read_file、grep 确认路径和内容是否还存在）',
      '- 不存代码能推导的（技术栈、目录结构）、git 能查的（谁改了什么）、文档已经写了的',
      '- 只存对话中出现的、其他地方推导不出来的信息（用户偏好、纠正反馈、项目决策、外部资源）',
    ];
    return lines.join('\n');
  }

  private parseFrontmatter(raw: string): Omit<MemoryEntry, 'filePath'> | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }

    const validTypes = ['user', 'feedback', 'project', 'reference'];
    if (!meta.name || !meta.type || !validTypes.includes(meta.type)) return null;

    return {
      name: meta.name,
      description: meta.description || '',
      type: meta.type as MemoryEntry['type'],
      content: match[2].trim(),
      lastWriteAt: meta.lastWriteAt ? Number(meta.lastWriteAt) : undefined,
      lastReadAt: meta.lastReadAt ? Number(meta.lastReadAt) : undefined,
    };
  }
}

```

## lint 体检 + TTL 分级

### src/memory/validator.ts

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEntry } from './store.js';

export interface ValidationIssue {
  kind: 'stale_path' | 'never_used' | 'duplicate_name';
  message: string;
}

export interface ValidationReport {
  entry: MemoryEntry;
  issues: ValidationIssue[];
}

const PATH_RE = /(?<![\w/])([\w./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|sql|yml|yaml|toml|env|sh|py))/g;

export function extractPaths(content: string): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(PATH_RE)) {
    paths.add(match[1]);
  }
  return Array.from(paths);
}

// 不同类型的记忆有不同的"保质期"
const TTL_BY_TYPE: Record<string, number> = {
  user: 365,       // 用户偏好几乎不过期
  feedback: 90,    // 纠正反馈保留 3 个月
  project: 30,     // 项目决策变化快，1 个月
  reference: 14,   // 外部资源引用需要频繁刷新
};

export function validateEntry(
  entry: MemoryEntry,
  baseDir = '.',
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const paths = extractPaths(entry.content);
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
    if (!fs.existsSync(abs)) {
      issues.push({
        kind: 'stale_path',
        message: `引用的路径不存在：${p}`,
      });
    }
  }

  if (entry.lastReadAt) {
    const staleDays = TTL_BY_TYPE[entry.type] ?? 30;
    const days = (Date.now() - entry.lastReadAt) / (1000 * 60 * 60 * 24);
    if (days > staleDays) {
      issues.push({
        kind: 'never_used',
        message: `已 ${Math.floor(days)} 天没被读过，超过 ${entry.type} 类型的 ${staleDays} 天保质期`,
      });
    }
  }

  return issues;
}

export function lintAll(
  entries: MemoryEntry[],
  baseDir = '.',
): ValidationReport[] {
  const reports: ValidationReport[] = [];

  const nameCount = new Map<string, number>();
  for (const e of entries) {
    nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);
  }

  for (const entry of entries) {
    const issues = validateEntry(entry, baseDir);
    if ((nameCount.get(entry.name) || 0) > 1) {
      issues.push({
        kind: 'duplicate_name',
        message: `存在 ${nameCount.get(entry.name)} 条同名记忆，可能需要合并`,
      });
    }
    if (issues.length > 0) reports.push({ entry, issues });
  }

  return reports;
}

```

前端增加lint入口，参考

```ts
import type { CommandHandler } from './index.js';

export const memoryCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== '/memory' && cmd !== 'memory') return false;
    const entries = ctx.memoryStore!.list();
    const reports = ctx.memoryStore!.lint();
    console.log(`\n[记忆系统] 共 ${entries.length} 条记忆，${reports.length} 条有警告`);
    for (const e of entries) {
      const hasIssue = reports.some(r => r.entry.filePath === e.filePath);
      const flag = hasIssue ? '⚠️ ' : '   ';
      console.log(`${flag} [${e.type}] ${e.name} — ${e.description}`);
    }
    console.log('');
    return true;
  },

  (cmd, ctx) => {
    if (cmd !== '/lint' && cmd !== 'lint') return false;
    const reports = ctx.memoryStore!.lint();
    if (reports.length === 0) {
      console.log('\n[lint] 记忆库健康，没有发现问题。\n');
      return true;
    }
    console.log(`\n[lint] 记忆库 ${reports.length} 条有警告：`);
    for (const r of reports) {
      console.log(`  📁 ${r.entry.filePath.split('/').pop()}  [${r.entry.type}] ${r.entry.name}`);
      for (const issue of r.issues) console.log(`     • ${issue.kind}: ${issue.message}`);
    }
    console.log('');
    return true;
  },

  (cmd, ctx) => {
    if (!cmd.startsWith('/memory search ') && !cmd.startsWith('搜记忆 ')) return false;
    const query = cmd.replace(/^\/memory search |^搜记忆 /, '').trim();
    const results = ctx.memoryStore!.search(query, 5);
    if (results.length === 0) {
      console.log(`\n[记忆搜索] 没有找到与 "${query}" 相关的记忆。\n`);
      return true;
    }
    console.log(`\n[BM25 搜索] "${query}" → ${results.length} 条结果：`);
    for (const h of results) {
      console.log(`  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} — ${h.entry.description}`);
    }
    console.log('');
    return true;
  },
];


```

## 记忆自动整理——/dream

```ts
import { type ModelMessage } from 'ai';
import { agentLoop } from '../agent/loop.js';
import type { CommandHandler } from './index.js';

const DREAM_PROMPT = [
  '请对记忆库做一次完整的整理（dream），按以下四个阶段执行：',
  '',
  '**阶段 1：定位** — 用 memory lint 扫描全库（lint 结果已包含内容预览和问题清单，不需要再逐条 read）。',
  '**阶段 2：整理** — 根据 lint 报告直接操作：',
  '  - 路径过期且长期未用的，直接 memory delete（传 filename）删掉',
  '  - 同名重复的，用 memory save 保存合并后的版本（同名自动覆盖），再 delete 多余的',
  '  - 内容仍然有效但描述不准确的，用 memory save 覆盖更新',
  '**阶段 3：报告** — 用一段文字总结这次整理做了什么。',
  '',
  '注意：memory 的 read 和 delete 都需要传 filename 参数（如 project_deploy-process.md），不是 name。lint 报告里已经有 filename 了，直接用。',
].join('\n');

export const dreamCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== '/dream' && cmd !== 'dream') return false;
    console.log('\n[dream] 开始记忆整理...');

    const userMsg: ModelMessage = { role: 'user', content: DREAM_PROMPT };
    ctx.messages.push(userMsg);
    ctx.timestamps.set(ctx.messages.length - 1, Date.now());
    ctx.sessionStore.append(userMsg);

    const currentSystem = ctx.builder.build(ctx.makePromptCtx());
    const beforeLen = ctx.messages.length;

    agentLoop(ctx.model, ctx.registry, ctx.messages, currentSystem, ctx.tracker).then(() => {
      const newMessages = ctx.messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < ctx.messages.length; i++) ctx.timestamps.set(i, now);
      ctx.sessionStore.appendAll(newMessages);
      console.log(`  [dream 完成]\n`);
      ctx.ask();
    });

    return 'async';
  },
];

```