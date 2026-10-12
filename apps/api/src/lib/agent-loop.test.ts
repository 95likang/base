import { ReadableStream } from 'node:stream/web'
import type { ModelMessage, UIMessageStreamWriter } from 'ai'
import { APICallError } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { agentLoop } from './agent-loop'

/**
 * 固定 agentLoop 的重试编排行为：
 * forwarded 守卫（已转发内容不重试）、attempt 计数、状态回滚。
 *
 * 技巧：所有可重试错误带 Retry-After: 0 → 退避等待 0ms，测试不拖速。
 */

/** 用错误 part 构造一次失败的 doStream 结果 */
function errorStream(error: unknown) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'error', error })
        controller.close()
      },
    }),
  }
}

/** 用文本 part 构造一次成功的 doStream 结果 */
function textStream(text: string) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 't' })
        controller.enqueue({ type: 'text-delta', id: 't', delta: text })
        controller.enqueue({ type: 'text-end', id: 't' })
        controller.enqueue({
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        })
        controller.close()
      },
    }),
  }
}

/** 先流出部分文本再失败的 doStream 结果（测 forwarded 守卫） */
function partialThenErrorStream(error: unknown) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 't' })
        controller.enqueue({ type: 'text-delta', id: 't', delta: '已流出一半' })
        controller.enqueue({ type: 'error', error })
        controller.close()
      },
    }),
  }
}

function rateLimitError(): APICallError {
  return new APICallError({
    message: 'rate limited',
    url: 'https://api.example.com',
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
    responseHeaders: { 'retry-after': '0' },
  })
}

function badRequestError(): APICallError {
  return new APICallError({
    message: 'bad request',
    url: 'https://api.example.com',
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  })
}

function mockWriter(): UIMessageStreamWriter & { chunks: unknown[] } {
  const chunks: unknown[] = []
  return {
    chunks,
    write: (chunk: unknown) => {
      chunks.push(chunk)
    },
  } as unknown as UIMessageStreamWriter & { chunks: unknown[] }
}

const MESSAGES: ModelMessage[] = [{ role: 'user', content: 'hi' }]

/** 捕获 agentLoop 抛出的错误（不匹配 message，便于断言结构化属性） */
async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error('expected agentLoop to reject')
}

describe('agentLoop 重试编排', () => {
  it('可重试错误（429）重试后成功：writer 收到最终文本', async () => {
    const results = [
      errorStream(rateLimitError()),
      errorStream(rateLimitError()),
      textStream('好了'),
    ]
    const model = new MockLanguageModelV3({
      doStream: () => results.shift() ?? textStream('unexpected'),
    })
    const writer = mockWriter()

    await agentLoop(model, {}, MESSAGES, 'test system', writer)

    // 2 次失败 + 1 次成功 = 3 次调用
    expect(model.doStreamCalls.length).toBe(3)
    // 前两次失败的输出没有泄漏到 writer，只有最终成功的内容
    const textDeltas = writer.chunks.filter((c) => (c as { type: string }).type === 'text-delta')
    expect(textDeltas).toEqual([{ type: 'text-delta', id: 't', delta: '好了' }])
  })

  it('已向客户端转发内容后失败 → 不重试，直接抛出', async () => {
    const model = new MockLanguageModelV3({
      doStream: vi.fn(() => partialThenErrorStream(rateLimitError())),
    })
    const writer = mockWriter()

    const error = await catchError(() => agentLoop(model, {}, MESSAGES, 'test system', writer))
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).statusCode).toBe(429)
    // 关键断言：只调用了 1 次（forwarded 守卫生效，未重试）
    expect(model.doStreamCalls.length).toBe(1)
    // 部分内容已转发（守卫的依据）
    expect(writer.chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
  })

  it('不可重试错误（400）→ 不重试，直接抛出', async () => {
    const model = new MockLanguageModelV3({
      doStream: vi.fn(() => errorStream(badRequestError())),
    })

    const error = await catchError(() =>
      agentLoop(model, {}, MESSAGES, 'test system', mockWriter()),
    )
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).statusCode).toBe(400)
    expect(model.doStreamCalls.length).toBe(1)
  })

  it('重试次数用尽 → 共 1+MAX_RETRIES 次调用后抛出', async () => {
    const model = new MockLanguageModelV3({
      doStream: vi.fn(() => errorStream(rateLimitError())),
    })

    const error = await catchError(() =>
      agentLoop(model, {}, MESSAGES, 'test system', mockWriter()),
    )
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).statusCode).toBe(429)
    expect(model.doStreamCalls.length).toBe(4)
  })
})
