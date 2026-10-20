import { generateText, type ModelMessage } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateTokens, microcompact, summarize } from './compressor'
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

/** 触发 summarize 阈值（100k token）所需的最小字符内容 */
const BIG_TEXT = 'x'.repeat(400_001)

let seq = 0
function userMsg(text: string): ModelMessage {
  return { role: 'user', content: text }
}
function assistantMsg(text: string): ModelMessage {
  return { role: 'assistant', content: text }
}
function toolMsg(toolName: string, text: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: `call-${toolName}-${seq++}`,
        toolName,
        output: textToolResultOutput(text),
      },
    ],
  }
}

/** 取 tool 消息第一个 part 的输出文本 */
function outputAt(messages: ModelMessage[], idx: number): string {
  const msg = messages[idx]
  if (msg.role !== 'tool') throw new Error(`messages[${idx}] 不是 tool 消息`)
  return toolResultOutputToText(msg.content[0].output)
}

beforeEach(() => {
  vi.mocked(generateText).mockReset()
})

describe('estimateTokens', () => {
  it('字符串 content 按 4 字符 / token 估算', () => {
    expect(estimateTokens([userMsg('abcd')])).toBe(1)
    expect(estimateTokens([userMsg('abc')])).toBe(1) // 向上取整
  })

  it('数组 content 统计 text 与工具输出', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'abcd' }] },
      toolMsg('read_file', 'abcd'),
    ]
    expect(estimateTokens(msgs)).toBe(2)
  })
})

describe('microcompact', () => {
  it('清空较早的可清空工具结果，保留最近 3 个', () => {
    const input = [
      userMsg('读一下文件'),
      assistantMsg('好的'),
      toolMsg('read_file', '文件内容A'.repeat(100)),
      toolMsg('read_file', '文件内容B'.repeat(100)),
      toolMsg('bash', '命令输出C'.repeat(100)),
      toolMsg('bash', '命令输出D'.repeat(100)),
      toolMsg('read_file', '文件内容E'.repeat(100)),
    ]
    const { messages, cleared } = microcompact(input)

    expect(cleared).toBe(2)
    // 前 2 个被清空
    expect(outputAt(messages, 2)).toBe('[tool result cleared]')
    expect(outputAt(messages, 3)).toBe('[tool result cleared]')
    // 最近 3 个保留原文
    expect(outputAt(messages, 4)).toContain('命令输出C')
    expect(outputAt(messages, 6)).toContain('文件内容E')
    // 非工具消息原样保留（同引用）
    expect(messages[0]).toBe(input[0])
  })

  it('不可清空的工具结果保留原文', () => {
    const input = [
      toolMsg('read_file', 'a'.repeat(10)),
      toolMsg('weather_tool', '北京 25 晴'),
      toolMsg('read_file', 'c'.repeat(10)),
      toolMsg('read_file', 'd'.repeat(10)),
      toolMsg('read_file', 'e'.repeat(10)),
    ]
    const { messages, cleared } = microcompact(input)
    // 清空窗口为前 2 个，其中 weather_tool 不可清空 → 只清空 1 个
    expect(cleared).toBe(1)
    expect(outputAt(messages, 0)).toBe('[tool result cleared]')
    expect(outputAt(messages, 1)).toBe('北京 25 晴')
  })

  it('工具结果不足 3 个时不清空', () => {
    const input = [userMsg('hi'), assistantMsg('ok'), toolMsg('bash', 'output')]
    const { messages, cleared } = microcompact(input)
    expect(cleared).toBe(0)
    expect(messages).toEqual(input)
  })
})

describe('summarize', () => {
  /** 12 条消息：token 超阈值且切分点可对齐到 user 边界 */
  function longHistory(): ModelMessage[] {
    return [
      userMsg(BIG_TEXT),
      assistantMsg('我看下文件'),
      toolMsg('read_file', 'src/index.ts 的内容'),
      assistantMsg('文件读完了'),
      userMsg('再帮我改一下'),
      assistantMsg('好的'),
      toolMsg('edit_file', '修改成功'),
      userMsg('现在跑一下测试'),
      assistantMsg('执行测试'),
      toolMsg('bash', '测试全部通过'),
      userMsg('总结一下'),
      assistantMsg('好的，总结如下'),
    ]
  }

  it('低于阈值或消息数不足时不触发', async () => {
    const model = {} as Parameters<typeof summarize>[0]
    const short = [userMsg('hi'), assistantMsg('ok')]
    const result = await summarize(model, short)
    expect(result.messages).toBe(short)
    expect(result.compressedCount).toBe(0)
    expect(vi.mocked(generateText)).not.toHaveBeenCalled()
  })

  it('超阈值时压缩最老一段为摘要消息，保留最近对话', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: '这是摘要' } as never)
    const model = {} as Parameters<typeof summarize>[0]
    const history = longHistory()

    const result = await summarize(model, history)

    // 12 条 → 切分点 6（tool）对齐到 4（user），压缩 4 条，保留 8 条 + 摘要 = 9
    expect(result.compressedCount).toBe(4)
    expect(result.messages).toHaveLength(9)
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: expect.stringContaining('这是摘要'),
    })
    expect(result.messages[1]).toBe(history[4]) // 保留段从对齐的 user 开始
    expect(result.messages.at(-1)).toBe(history[11])
    // 摘要调用包含旧对话内容
    const prompt = vi.mocked(generateText).mock.calls[0][0].prompt
    expect(prompt).toContain('src/index.ts 的内容')
    // 保留段不含被压缩的内容
    expect(prompt).not.toContain('总结一下')
  })

  it('LLM 摘要失败时降级返回原消息', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('rate limit'))
    const model = {} as Parameters<typeof summarize>[0]
    const history = longHistory()

    const result = await summarize(model, history)
    expect(result.messages).toBe(history)
    expect(result.compressedCount).toBe(0)
  })

  it('切分点对齐到 0 时（开头就是唯一 user 边界）不压缩', async () => {
    // 8 条消息，切分点 2 向前只能对齐到 0
    const history: ModelMessage[] = [
      userMsg(BIG_TEXT),
      assistantMsg('ok'),
      toolMsg('bash', 'out'),
      assistantMsg('ok'),
      assistantMsg('ok'),
      assistantMsg('ok'),
      assistantMsg('ok'),
      assistantMsg('ok'),
    ]
    const model = {} as Parameters<typeof summarize>[0]

    const result = await summarize(model, history)
    expect(result.messages).toBe(history)
    expect(vi.mocked(generateText)).not.toHaveBeenCalled()
  })
})
