import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectTrace, LocalTraceRecorder } from './recorder'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trace-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }

describe('LocalTraceRecorder', () => {
  it('按顺序追加事件，inspectTrace 复盘出工具名与 token', async () => {
    const recorder = await LocalTraceRecorder.start({
      directory: await makeTempDir(),
      sessionId: 'chat/1',
      model: 'test-model',
    })

    await recorder.recordStepStarted({
      step: 1,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await recorder.recordStepCompleted({
      step: 1,
      text: 'done',
      outputMessages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'grep', input: {} }],
        },
      ],
      usage,
    })
    await recorder.finish('completed')

    const events = (await readFile(recorder.filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string })
    expect(events.map((event) => event.type)).toEqual([
      'trace_started',
      'step_started',
      'step_completed',
      'trace_finished',
    ])

    const summary = await inspectTrace(recorder.filePath)
    expect(summary).toContain('状态    completed')
    expect(summary).toContain('工具: grep')
    expect(summary).toContain('input 10 / output 5')
  })

  it('按字段名脱敏 API Key / Token', async () => {
    const recorder = await LocalTraceRecorder.start({
      directory: await makeTempDir(),
      sessionId: 'chat-1',
      model: 'test-model',
    })
    // 故意构造带敏感字段的消息（真实 ModelMessage 不会这样，模拟上下文里的配置对象）
    const messages = [
      { role: 'user', content: 'hi', apiKey: 'sk-secret-value' },
    ] as unknown as ModelMessage[]

    await recorder.recordStepStarted({ step: 1, system: 'sys', messages })

    const raw = await readFile(recorder.filePath, 'utf8')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('sk-secret-value')
  })
})
