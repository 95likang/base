import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一个 skill：目录名即名称，内容来自 SKILL.md 的 frontmatter + 正文 */
export interface SkillDefinition {
  name: string
  description: string
  whenToUse?: string
  content: string
  /** 停用的 skill 不注入 prompt、不可被模型加载（目录下存在 .disabled 标记） */
  enabled: boolean
}

const SKILL_FILE = 'SKILL.md'
/** 停用标记：目录内空文件，避免改写 SKILL.md 正文（用户可能随时重传） */
const DISABLED_MARKER = '.disabled'
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

/** 目录名白名单校验：同时用于上传接口，挡住路径穿越 */
export function isValidSkillName(name: string): boolean {
  return NAME_PATTERN.test(name)
}

/**
 * 扫描 / 管理 skills 目录：每个子目录下的 SKILL.md 是一个 skill。
 * 变更操作（保存/删除/停用）后立即重新扫描，无需重启进程。
 */
export class SkillLoader {
  private skills = new Map<string, SkillDefinition>()

  constructor(private readonly dirPath: string) {}

  load(): SkillDefinition[] {
    this.skills.clear()
    if (!existsSync(this.dirPath)) return []

    for (const entry of readdirSync(this.dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillDir = join(this.dirPath, entry.name)
      const skillFile = join(skillDir, SKILL_FILE)
      if (!existsSync(skillFile)) continue

      const parsed = parseSkillFile(readFileSync(skillFile, 'utf-8'))
      this.skills.set(entry.name, {
        name: entry.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        enabled: !existsSync(join(skillDir, DISABLED_MARKER)),
      })
    }
    return this.list()
  }

  /** 启用的 skills（注入 prompt、允许模型加载）；按名称排序保证 prompt 稳定 */
  list(): SkillDefinition[] {
    return this.listAll().filter((skill) => skill.enabled)
  }

  /** 全部 skills（管理页用，含停用） */
  listAll(): SkillDefinition[] {
    return Array.from(this.skills.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 只有启用的 skill 可被模型加载 */
  get(name: string): SkillDefinition | undefined {
    const skill = this.skills.get(name)
    return skill?.enabled ? skill : undefined
  }

  /** 写入（或覆盖）skill 内容；名称非法或内容为空时抛错 */
  save(name: string, content: string): SkillDefinition {
    if (!isValidSkillName(name)) {
      throw new Error('技能名称只能包含字母、数字、下划线和短横线（≤64 字符）')
    }
    if (!content.trim()) {
      throw new Error('SKILL.md 内容不能为空')
    }
    const skillDir = join(this.dirPath, name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, SKILL_FILE), content, 'utf-8')
    this.load()
    const saved = this.skills.get(name)
    if (!saved) throw new Error('保存后未能读取到 skill')
    return saved
  }

  /** 删除 skill 目录；不存在返回 false */
  remove(name: string): boolean {
    if (!this.skills.has(name)) return false
    rmSync(join(this.dirPath, name), { recursive: true, force: true })
    this.load()
    return true
  }

  /** 启用/停用；通过 .disabled 标记文件生效，不改写 SKILL.md；不存在返回 false */
  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.skills.has(name)) return false
    const marker = join(this.dirPath, name, DISABLED_MARKER)
    if (enabled) {
      rmSync(marker, { force: true })
    } else {
      writeFileSync(marker, '')
    }
    this.load()
    return true
  }
}

/**
 * 解析 frontmatter（name / description / when_to_use）与正文。
 * 无 frontmatter 时整篇视为正文。
 */
export function parseSkillFile(raw: string): {
  name?: string
  description: string
  whenToUse?: string
  content: string
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { description: '', content: raw.trim() }

  const meta: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    meta[key] = value
  }

  return {
    name: meta.name || undefined,
    description: meta.description || '',
    whenToUse: meta.when_to_use || undefined,
    content: (match[2] ?? '').trim(),
  }
}
