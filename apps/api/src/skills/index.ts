import { join } from 'node:path'
import { SkillLoader } from './loader'

/**
 * Skills 目录：<cwd>/src/.skills（本仓库约定）。
 * 进程启动时扫描一次；新增/修改 SKILL.md 后重启生效。
 */
export const skillLoader = new SkillLoader(join(process.cwd(), 'src', '.skills'))

skillLoader.load()
