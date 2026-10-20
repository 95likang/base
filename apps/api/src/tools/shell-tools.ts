import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { WORKSPACE_ROOT } from './file-tools'
import type { ToolDefinition, ToolExecuteOptions } from './registry'

/** 异步执行 shell：execSync 会阻塞整个事件循环，命令跑多久所有请求就挂多久 */
const execAsync = promisify(exec)

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: '执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }: { command: string }, options: ToolExecuteOptions) => {
    try {
      await execAsync('echo test', { cwd: WORKSPACE_ROOT })
    } catch {
      return `[bash 不可用] 当前 Sandbox 不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。`
    }

    try {
      const { stdout } = await execAsync(command, {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        cwd: WORKSPACE_ROOT,
        signal: options.abortSignal,
      })
      return stdout || '(命令执行成功，无输出)'
    } catch (err) {
      // exec 失败时 err 携带 stdout/stderr/status/killed/signal，做结构化收窄
      const e = err as {
        stderr?: string
        stdout?: string
        status?: number | null
        message?: string
        killed?: boolean
        signal?: NodeJS.Signals | null
      }
      if (e.killed) {
        return `命令被终止 (${e.signal ?? '超时或中止'})`
      }
      const stderr = e.stderr || ''
      const stdout = e.stdout || ''
      return `命令执行失败 (exit ${e.status || 1}):\n${stderr || stdout || e.message}`
    }
  },
}
