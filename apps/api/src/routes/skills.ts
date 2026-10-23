import { basename, extname } from 'node:path'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { ApiError, validationHook } from '../lib/api-error'
import { skillLoader } from '../skills'
import { isValidSkillName, parseSkillFile, type SkillDefinition } from '../skills/loader'

/** 单个 SKILL.md 上传上限：技能是纯文本指令，256KB 足够 */
const MAX_UPLOAD_BYTES = 256 * 1024
/** multipart 边界与表单字段的额外开销余量 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024

const enabledSchema = z.object({ enabled: z.boolean() })

/** 列表不返回正文：SKILL.md 可能很长，管理页只用索引信息 */
function toSummary(skill: SkillDefinition) {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    enabled: skill.enabled,
  }
}

/**
 * Skills 管理路由（admin 管理页的数据源）。文件落在 <cwd>/src/.skills/<name>/SKILL.md。
 * GET    /            全部 skills（含停用）
 * POST   /            multipart 上传 SKILL.md（名称取表单 name → frontmatter name → 文件名）
 * PATCH  /:name       启用/停用（{ enabled }）
 * DELETE /:name       删除 skill 目录
 */
export const skillsRoute = new Hono()
  .get('/', (c) => {
    return c.json({ skills: skillLoader.listAll().map(toSummary) })
  })
  .post('/', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
      throw new ApiError('FILE_TOO_LARGE', '文件超过 256KB 上限', 413)
    }

    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) {
      throw new ApiError('FILE_REQUIRED', '缺少 file 字段（multipart/form-data）', 400)
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ApiError('FILE_TOO_LARGE', '文件超过 256KB 上限', 413)
    }

    const raw = await file.text()
    const parsed = parseSkillFile(raw)
    const formName = typeof body.name === 'string' ? body.name.trim() : ''
    // 只保留文件名部分，防止客户端伪造路径
    const stem = basename(file.name, extname(file.name)).trim()
    const name = formName || parsed.name || (stem.toLowerCase() === 'skill' ? '' : stem)

    if (!isValidSkillName(name)) {
      throw new ApiError(
        'SKILL_NAME_INVALID',
        '技能名称只能包含字母、数字、下划线和短横线（≤64 字符）；上传 SKILL.md 时请在表单里填写名称',
        400,
      )
    }
    if (!raw.trim()) {
      throw new ApiError('SKILL_EMPTY', 'SKILL.md 内容不能为空', 400)
    }

    const saved = skillLoader.save(name, raw)
    return c.json({ skill: toSummary(saved) }, 201)
  })
  .patch('/:name', zValidator('json', enabledSchema, validationHook), (c) => {
    const name = c.req.param('name')
    const { enabled } = c.req.valid('json')
    if (!skillLoader.setEnabled(name, enabled)) {
      throw new ApiError('SKILL_NOT_FOUND', `找不到 skill: ${name}`, 404)
    }
    return c.json({ ok: true, enabled })
  })
  .delete('/:name', (c) => {
    const name = c.req.param('name')
    if (!skillLoader.remove(name)) {
      throw new ApiError('SKILL_NOT_FOUND', `找不到 skill: ${name}`, 404)
    }
    return c.json({ ok: true })
  })
