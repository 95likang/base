import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillLoader } from './loader'

describe('SkillLoader', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (name: string, raw: string) => {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'SKILL.md'), raw)
  }

  it('目录不存在时返回空列表', () => {
    expect(new SkillLoader(join(dir, 'missing')).load()).toEqual([])
  })

  it('目录名即名称，解析 frontmatter 与正文', () => {
    write(
      'code-review',
      '---\nname: ignored\ndescription: "审查代码"\nwhen_to_use: 用户要求 review 时\n---\n\n# 流程\n\n先读文件',
    )
    const loader = new SkillLoader(dir)
    loader.load()

    expect(loader.list()).toEqual([
      {
        name: 'code-review',
        description: '审查代码',
        whenToUse: '用户要求 review 时',
        content: '# 流程\n\n先读文件',
        enabled: true,
      },
    ])
    expect(loader.get('code-review')?.content).toContain('先读文件')
    expect(loader.get('missing')).toBeUndefined()
  })

  it('无 frontmatter 时整篇视为正文；缺 SKILL.md 的目录被忽略', () => {
    write('plain', '只有正文')
    mkdirSync(join(dir, 'empty'))
    const skills = new SkillLoader(dir).load()

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'plain', description: '', content: '只有正文' })
  })

  it('停用后 list/get 不可见，listAll 仍可管理', () => {
    write('review', '---\ndescription: 审查\n---\n正文')
    const loader = new SkillLoader(dir)
    loader.load()

    expect(loader.setEnabled('review', false)).toBe(true)
    expect(loader.list()).toEqual([])
    expect(loader.get('review')).toBeUndefined()
    expect(loader.listAll()[0]).toMatchObject({ name: 'review', enabled: false })

    expect(loader.setEnabled('review', true)).toBe(true)
    expect(loader.get('review')?.enabled).toBe(true)
    expect(loader.setEnabled('missing', true)).toBe(false)
  })

  it('save 写入后可立即读取，非法名称/空内容被拒绝', () => {
    const loader = new SkillLoader(dir)
    loader.load()
    loader.save('deploy', '---\ndescription: 发布流程\n---\n第一步')

    expect(loader.get('deploy')?.content).toBe('第一步')
    expect(readFileSync(join(dir, 'deploy', 'SKILL.md'), 'utf-8')).toContain('第一步')
    expect(() => loader.save('../escape', 'x')).toThrow('技能名称')
    expect(() => loader.save('ok-name', '   ')).toThrow('不能为空')
  })

  it('remove 删除整个 skill 目录', () => {
    write('temp', '正文')
    const loader = new SkillLoader(dir)
    loader.load()

    expect(loader.remove('temp')).toBe(true)
    expect(existsSync(join(dir, 'temp'))).toBe(false)
    expect(loader.remove('temp')).toBe(false)
  })
})
