## 给 Agent 装上 Skill 加载能力

### src/skills/loader.ts

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  dirPath: string;
}

const SKILLS_DIR = '.skills';
const SKILL_FILE = 'SKILL.md';

export class SkillLoader {
  private readonly baseDir: string;
  private skills = new Map<string, SkillDefinition>();

  constructor(baseDir = '.') {
    this.baseDir = baseDir;
  }

  private get skillsDir(): string {
    return path.join(this.baseDir, SKILLS_DIR);
  }

  load(): SkillDefinition[] {
    this.skills.clear();
    if (!fs.existsSync(this.skillsDir)) return [];

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(this.skillsDir, entry.name, SKILL_FILE);
      if (!fs.existsSync(skillFile)) continue;

      const raw = fs.readFileSync(skillFile, 'utf-8');
      const parsed = this.parseFrontmatter(raw);
      if (!parsed) continue;

      const skill: SkillDefinition = {
        name: entry.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        dirPath: path.join(this.skillsDir, entry.name),
      };
      this.skills.set(skill.name, skill);
    }

    return this.list();
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  buildPromptSection(activeSkills: Set<string>): string | null {
    if (this.skills.size === 0) return null;

    const lines: string[] = [];

    if (activeSkills.size > 0) {
      for (const name of activeSkills) {
        const skill = this.skills.get(name);
        if (!skill) continue;
        lines.push(`[激活的 Skill: ${skill.name}]`);
        lines.push(skill.content);
        lines.push('');
      }
    }

    const available = this.list()
      .filter(s => !activeSkills.has(s.name))
      .map(s => {
        const hint = s.whenToUse ? ` (适用场景: ${s.whenToUse})` : '';
        return `  /${s.name} — ${s.description}${hint}`;
      });

    if (available.length > 0) {
      lines.push('可用的 Skills（输入 /skill load <name> 激活）：');
      lines.push(...available);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  private parseFrontmatter(raw: string): { description: string; whenToUse?: string; content: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { description: '', content: raw };

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        meta[key] = value;
      }
    }

    return {
      description: meta.description || '',
      whenToUse: meta.when_to_use || undefined,
      content: match[2].trim(),
    };
  }
}

```

集成 只需要三步：创建 SkillLoader、调 load() 扫描可用的 skill、把 buildPromptSection 接到 PromptBuilder 的 pipe 上（跟 memory、RAG 一样的套路——每轮对话前动态构建 system prompt）。

## 前端参考

```ts
import { type ModelMessage } from 'ai';
import { agentLoop } from '../agent/loop.js';
import type { CommandHandler } from './index.js';
import type { SkillLoader } from '../skills/loader.js';

export function createSkillCommands(skillLoader: SkillLoader, activeSkills: Set<string>): CommandHandler[] {
  return [
    // /skill list
    (cmd, ctx) => {
      if (cmd !== '/skill' && cmd !== '/skill list' && cmd !== 'skill list') return false;
      const skills = skillLoader.list();
      if (skills.length === 0) {
        console.log('\n[skills] 没有找到任何 skill。在 .skills/ 目录下创建 skill-name/SKILL.md 即可。\n');
        return true;
      }
      console.log(`\n[skills] 共 ${skills.length} 个可用：`);
      for (const s of skills) {
        const active = activeSkills.has(s.name) ? ' ✓ 已激活' : '';
        console.log(`  /${s.name} — ${s.description}${active}`);
        if (s.whenToUse) console.log(`    适用场景: ${s.whenToUse}`);
      }
      console.log('');
      return true;
    },

    // /skill load <name>
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+load\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      const skill = skillLoader.get(name);
      if (!skill) {
        console.log(`\n[skills] 找不到 skill: ${name}\n`);
        return true;
      }
      activeSkills.add(name);
      console.log(`\n[skills] 已激活: ${name} — ${skill.description}\n`);
      return true;
    },

    // /skill unload <name>
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+unload\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      if (!activeSkills.has(name)) {
        console.log(`\n[skills] ${name} 未激活\n`);
        return true;
      }
      activeSkills.delete(name);
      console.log(`\n[skills] 已卸载: ${name}\n`);
      return true;
    },

    // /<skill-name> — 直接用 /code-review 激活并触发
    (cmd, ctx) => {
      if (!cmd.startsWith('/')) return false;
      const parts = cmd.slice(1).split(/\s+/);
      const name = parts[0];
      const skill = skillLoader.get(name);
      if (!skill) return false;

      activeSkills.add(name);
      console.log(`\n[skills] 激活 ${name}，开始执行...`);

      const args = parts.slice(1).join(' ');
      const content = args
        ? `${skill.content}\n\n用户指令: ${args}`
        : skill.content;

      const userMsg: ModelMessage = { role: 'user', content };
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
        ctx.ask();
      });

      return 'async';
    },
  ];
}

```