import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './loader'

const tempDirs: string[] = []

function writeConfigFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'config-test-'))
  tempDirs.push(dir)
  const path = join(dir, 'super-agent.config.json')
  writeFileSync(path, JSON.stringify(content))
  return path
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('文件不存在时使用默认配置', () => {
    const config = loadConfig(join(tmpdir(), 'missing-super-agent.config.json'))
    expect(config.model.name).toBe(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5')
    expect(config.agents.maxConcurrent).toBe(3)
    expect(config.cron.enabled).toBe(true)
  })

  it('把环境变量占位符替换成实际值', () => {
    vi.stubEnv('TEST_CONFIG_API_KEY', 'sk-test')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 测试配置里的占位符，不是模板字符串
    const path = writeConfigFile({ model: { apiKey: '${TEST_CONFIG_API_KEY}' } })
    expect(loadConfig(path).model.apiKey).toBe('sk-test')
  })

  it('校验失败时抛出包含字段路径的错误', () => {
    const path = writeConfigFile({ agents: { maxConcurrent: 0 } })
    expect(() => loadConfig(path)).toThrow(/agents\.maxConcurrent/)
  })

  it('占位符引用的环境变量缺失时抛出字段路径', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 测试配置里的占位符，不是模板字符串
    const path = writeConfigFile({ database: { url: '${MISSING_CONFIG_VAR}' } })
    expect(() => loadConfig(path)).toThrow(/database\.url/)
  })
})
