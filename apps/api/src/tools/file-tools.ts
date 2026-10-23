import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import fg from 'fast-glob'
import { config } from '../config/loader'
import type { ToolDefinition } from './registry'

/** 工作区根目录：文件工具只能访问其中的相对路径（导出给其他工具复用，如预览服务器） */
export const WORKSPACE_ROOT = resolvePath(config.tools.workspaceDir)

/**
 * 工作区守卫开关：tools.guard=false 时关闭越界检查，
 * resolveWorkspacePath() 退化为普通路径解析（相对 WORKSPACE_ROOT，绝对路径直接放行）。
 * 默认开启；关闭后模型可访问服务器任意路径，仅限本地开发使用。
 */
const GUARD_ENABLED = config.tools.guard

/** 解析为工作区内的绝对路径；越界（../、绝对路径、其他盘符）直接抛错 */
export function resolveWorkspacePath(userPath: string): string {
  const abs = resolvePath(WORKSPACE_ROOT, userPath)
  if (GUARD_ENABLED && abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + sep)) {
    throw new Error('路径越界：只能访问工作区内的相对路径')
  }
  return abs
}

/** 绝对路径转工作区相对路径（统一用 / 分隔，用作文档 source） */
export function workspaceRelativePath(absPath: string): string {
  return relative(WORKSPACE_ROOT, absPath).split(sep).join('/')
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取指定路径的文件内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500, // 演示用，生产环境通常 50000+
  execute: async ({ path }: { path: string }) => {
    return readFileSync(resolveWorkspacePath(path), 'utf-8')
  },
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '写入内容到指定文件',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  isConcurrencySafe: false, // 写操作不能并行
  isReadOnly: false,
  execute: async ({ path, content }: { path: string; content: string }) => {
    writeFileSync(resolveWorkspacePath(path), content, 'utf-8')
    return `已写入 ${content.length} 字符到 ${path}`
  },
}

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: '列出指定目录下的文件和子目录',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，默认为当前目录' },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path = '.' }: { path?: string }) => {
    const resolved = resolveWorkspacePath(path)
    return readdirSync(resolved)
      .map((name) => {
        const stat = statSync(join(resolved, name))
        return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}`
      })
      .join('\n')
  },
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    '精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配）' },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({
    path,
    old_string,
    new_string,
  }: {
    path: string
    old_string: string
    new_string: string
  }) => {
    const resolved = resolveWorkspacePath(path)
    if (!existsSync(resolved)) return `文件不存在: ${path}`

    const content = readFileSync(resolved, 'utf-8')
    const count = content.split(old_string).length - 1

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`
    }

    const updated = content.replace(old_string, new_string)
    writeFileSync(resolved, updated, 'utf-8')
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`
  },
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
    // fast-glob 对绝对路径模式会忽略 cwd（文档化行为），".." 段可逃逸工作区，
    // Windows 盘符前缀（C:...）同理——守卫开启时一律拒绝，只允许工作区内相对模式
    if (
      GUARD_ENABLED &&
      (isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.split(/[/\\]/).includes('..'))
    ) {
      return `非法 pattern：只允许工作区内的相对模式（不允许绝对路径或 ".."）`
    }
    const results = await fg(pattern, {
      cwd: resolveWorkspacePath(path),
      ignore: ['node_modules/**', '.git/**'],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    })
    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`
    return results.sort().join('\n')
  },
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
    const baseDir = resolveWorkspacePath(path)
    const regex = new RegExp(pattern, 'i')
    const matches: string[] = []
    const SKIP = new Set(['node_modules', '.git', 'dist'])
    const BIN_EXT = new Set(['.png', '.jpg', '.gif', '.woff', '.woff2', '.ico', '.lock'])

    function searchFile(filePath: string) {
      if (matches.length >= 50) return
      const ext = filePath.slice(filePath.lastIndexOf('.'))
      if (BIN_EXT.has(ext)) return

      let content: string
      try {
        content = readFileSync(filePath, 'utf-8')
      } catch {
        return
      }

      const lines = content.split('\n')
      const rel = relative(baseDir, filePath)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line === undefined) continue
        if (regex.test(line)) {
          matches.push(`${rel}:${i + 1}: ${line.trimEnd()}`)
          if (matches.length >= 50) return
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const name of entries) {
        if (SKIP.has(name)) continue
        const full = join(dir, name)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) walk(full)
          else searchFile(full)
        } catch {
          /* skip */
        }
      }
    }

    const stat = statSync(baseDir)
    if (stat.isFile()) {
      searchFile(baseDir)
    } else {
      walk(baseDir)
    }

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`
    const suffix = matches.length >= 50 ? '\n... (结果已截断，共 50+ 条匹配)' : ''
    return matches.join('\n') + suffix
  },
}
