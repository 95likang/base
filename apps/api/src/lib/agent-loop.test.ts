import { ReadableStream } from 'node:stream/web'
import type { ModelMessage, UIMessageStreamWriter } from 'ai'
import { APICallError, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { agentLoop, type BudgetState } from './agent-loop'

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
          finishReason: { unified: 'stop', raw: 'stop' },
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

/** 指定用量的 finish part（Token 预算测试用） */
const usage = (tokens: number) => ({
  inputTokens: { total: tokens, noCache: tokens, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
})

/** 一步带工具调用的 doStream 结果（驱动循环进入下一步） */
function toolCallStream(tokens: number) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'echo',
          input: '{}',
        })
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: usage(tokens),
        })
        controller.close()
      },
    }),
  }
}

/** 一步纯文本回复的 doStream 结果，带指定用量 */
function textStreamWithUsage(text: string, tokens: number) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 't' })
        controller.enqueue({ type: 'text-delta', id: 't', delta: text })
        controller.enqueue({ type: 'text-end', id: 't' })
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: usage(tokens),
        })
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

/** 每个测试新鲜的消息数组：agentLoop 会往里 push 工具消息，共享实例会级联污染后续测试 */
const makeMessages = (): ModelMessage[] => [{ role: 'user', content: 'hi' }]

/** 预算测试用的 echo 工具 */
const echoTools = {
  echo: tool({ inputSchema: z.object({}), execute: async () => 'ok' }),
}

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

    await agentLoop(model, {}, makeMessages(), 'test system', writer)

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

    const error = await catchError(() =>
      agentLoop(model, {}, makeMessages(), 'test system', writer),
    )
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
      agentLoop(model, {}, makeMessages(), 'test system', mockWriter()),
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
      agentLoop(model, {}, makeMessages(), 'test system', mockWriter()),
    )
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).statusCode).toBe(429)
    expect(model.doStreamCalls.length).toBe(4)
  })
})

describe('agentLoop Token 预算', () => {
  it('预算耗尽 → 不再发起下一步调用，前端收到预算提示', async () => {
    // 第 1 步工具调用用掉 600 token（超预算 500），循环应在下一步前终止
    const model = new MockLanguageModelV3({
      doStream: vi.fn(() => toolCallStream(600)),
    })
    const writer = mockWriter()
    const budget: BudgetState = { used: 0, limit: 500 }

    await agentLoop(model, echoTools, makeMessages(), 'test system', writer, undefined, budget)

    // 只调了 1 次（预算检查挡住了第 2 步）
    expect(model.doStreamCalls.length).toBe(1)
    expect(budget.used).toBe(600)
    // 前端收到预算耗尽提示
    const budgetChunk = writer.chunks.find(
      (c) =>
        (c as { type: string }).type === 'text-delta' &&
        (c as { delta: string }).id === 'token-budget-exhausted',
    )
    expect(budgetChunk).toMatchObject({ type: 'text-delta', id: 'token-budget-exhausted' })
  })

  it('预算充足 → 工具步 + 回复步正常完成，用量累计', async () => {
    const results = [toolCallStream(100), textStreamWithUsage('done', 50)]
    const model = new MockLanguageModelV3({
      doStream: () => results.shift() ?? textStream('unexpected'),
    })
    const writer = mockWriter()
    const budget: BudgetState = { used: 0, limit: 1000 }

    await agentLoop(model, echoTools, makeMessages(), 'test system', writer, undefined, budget)

    expect(model.doStreamCalls.length).toBe(2)
    expect(budget.used).toBe(150)
    // 正常收尾，无预算提示
    expect(writer.chunks.some((c) => (c as { id?: string }).id === 'token-budget-exhausted')).toBe(
      false,
    )
  })

  it('最终回复步超额 → 回复已完整，不算预算终止', async () => {
    // 纯文本回复一步用 800（超预算 500），但本步已是最终回复：正常收尾
    const model = new MockLanguageModelV3({
      doStream: vi.fn(() => textStreamWithUsage('final answer', 800)),
    })
    const writer = mockWriter()
    const budget: BudgetState = { used: 0, limit: 500 }

    await agentLoop(model, {}, makeMessages(), 'test system', writer, undefined, budget)

    expect(model.doStreamCalls.length).toBe(1)
    expect(budget.used).toBe(800)
    expect(writer.chunks.some((c) => (c as { id?: string }).id === 'token-budget-exhausted')).toBe(
      false,
    )
  })

  it('不传预算 → 行为不受影响', async () => {
    const model = new MockLanguageModelV3({
      doStream: vi.fn(() => textStream('ok')),
    })

    await agentLoop(model, {}, makeMessages(), 'test system', mockWriter())
    expect(model.doStreamCalls.length).toBe(1)
  })
})
