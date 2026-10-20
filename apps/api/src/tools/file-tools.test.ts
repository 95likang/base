import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 最小冒烟测试：临时目录覆盖工作区根，验证三个工具的基本行为与越界防御。
 * 工具在模块加载时读取 TOOL_WORKSPACE_DIR，故在动态 import 前设置。
 */

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-tools-'))
  process.env.TOOL_WORKSPACE_DIR = root
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  delete process.env.TOOL_WORKSPACE_DIR
})

// 模块级常量在 import 时求值，放到用例内 import 才能拿到上面设置的 env
async function load() {
  const files = await import('./file-tools')
  const shell = await import('./shell-tools')
  return {
    readFile: files.readFileTool,
    writeFile: files.writeFileTool,
    list: files.listDirectoryTool,
    edit: files.editFileTool,
    glob: files.globTool,
    grep: files.grepTool,
    bash: shell.bashTool,
  }
}

describe('文件工具冒烟', () => {
  it('write → read 闭环', async () => {
    const { readFile, writeFile } = await load()
    await writeFile.execute({ path: 'a.txt', content: 'hello' }, {})
    const out = await readFile.execute({ path: 'a.txt' }, {})
    expect(out).toBe('hello')
  })

  it('list_directory 输出 [DIR]/[FILE] 前缀', async () => {
    const { writeFile, list } = await load()
    await fs.mkdir(path.join(root, 'sub'))
    await writeFile.execute({ path: 'sub/b.txt', content: 'x' }, {})
    const out = await list.execute({ path: '.' }, {})
    expect(String(out)).toContain('[FILE] a.txt')
    expect(String(out)).toContain('[DIR] sub')
  })

  it('../ 越界被拒绝', async () => {
    const { readFile } = await load()
    await expect(readFile.execute({ path: '../escape.txt' }, {})).rejects.toThrow('路径越界')
  })

  it('TOOL_WORKSPACE_GUARD=false 时关闭越界检查', async () => {
    // 守卫开关是模块级常量，需重置模块缓存后重新 import 才能读到新 env
    process.env.TOOL_WORKSPACE_GUARD = 'false'
    vi.resetModules()
    try {
      const mod = await import('./file-tools')
      // 工作区外放一个文件，关闭守卫后可以越界读
      const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`)
      await fs.writeFile(outside, 'outside content')
      const out = await mod.readFileTool.execute({ path: `../${path.basename(outside)}` }, {})
      expect(out).toBe('outside content')
    } finally {
      delete process.env.TOOL_WORKSPACE_GUARD
      vi.resetModules()
    }
  })
})

describe('edit_file / glob / grep / bash', () => {
  it('edit_file：唯一匹配才替换，多处匹配要求补上下文', async () => {
    const { writeFile, readFile, edit } = await load()
    await writeFile.execute({ path: 'code.ts', content: 'const a = 1\nconst b = 2\n' }, {})

    // 多处匹配 → 拒绝替换
    const dup = await edit.execute({ path: 'code.ts', old_string: 'const', new_string: 'let' }, {})
    expect(String(dup)).toContain('2 处匹配')

    // 唯一匹配 → 替换成功
    const ok = await edit.execute(
      { path: 'code.ts', old_string: 'const b', new_string: 'let b' },
      {},
    )
    expect(String(ok)).toContain('已替换')
    const out = await readFile.execute({ path: 'code.ts' }, {})
    // 简版 read 原样返回，末尾换行保留
    expect(out).toBe('const a = 1\nlet b = 2\n')

    // 无匹配
    const none = await edit.execute({ path: 'code.ts', old_string: 'xxx', new_string: 'yyy' }, {})
    expect(String(none)).toContain('未找到匹配内容')
  })

  it('glob：按模式匹配文件', async () => {
    const { writeFile, glob } = await load()
    await fs.mkdir(path.join(root, 'src/deep'), { recursive: true })
    await writeFile.execute({ path: 'src/a.ts', content: '1' }, {})
    await writeFile.execute({ path: 'src/deep/b.ts', content: '1' }, {})
    await writeFile.execute({ path: 'src/c.json', content: '1' }, {})

    const out = await glob.execute({ pattern: '**/*.ts' }, {})
    expect(String(out)).toContain('src/a.ts')
    expect(String(out)).toContain('src/deep/b.ts')
    expect(String(out)).not.toContain('c.json')

    const empty = await glob.execute({ pattern: '**/*.xyz' }, {})
    expect(String(empty)).toContain('没有找到')
  })

  it('glob：绝对路径/.. 模式被守卫拒绝', async () => {
    const { glob } = await load()
    // fast-glob 对绝对路径模式忽略 cwd，.. 段可逃逸工作区——必须拦截
    const abs = await glob.execute({ pattern: 'C:/**' }, {})
    expect(String(abs)).toContain('非法 pattern')
    const dotdot = await glob.execute({ pattern: '../**/*.ts' }, {})
    expect(String(dotdot)).toContain('非法 pattern')
    // 普通相对模式不受影响
    const ok = await glob.execute({ pattern: 'src/*.ts' }, {})
    expect(String(ok)).toContain('src/a.ts')
  })

  it('grep：返回相对路径+行号+内容', async () => {
    const { writeFile, grep } = await load()
    await fs.mkdir(path.join(root, 'grep-dir'), { recursive: true })
    await writeFile.execute(
      { path: 'grep-dir/x.txt', content: 'hello world\nfoo\nHELLO again\n' },
      {},
    )

    const out = await grep.execute({ pattern: 'hello', path: 'grep-dir' }, {})
    expect(String(out)).toContain('x.txt:1: hello world')
    expect(String(out)).toContain('x.txt:3: HELLO again') // 大小写不敏感

    const none = await grep.execute({ pattern: 'zzz', path: 'grep-dir' }, {})
    expect(String(none)).toContain('没有找到')
  })

  it('bash：在工作区内执行命令', async () => {
    const { bash } = await load()
    const out = await bash.execute({ command: 'echo hi-from-bash' }, {})
    expect(String(out)).toContain('hi-from-bash')
  })

  it('bash：失败命令返回 exit 状态而非抛异常', async () => {
    const { bash } = await load()
    const out = await bash.execute({ command: 'definitely-not-a-command-xyz' }, {})
    expect(String(out)).toContain('exit 1')
  })
})
