import type { ModelMessage, UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  applyDefense,
  buildTimestampedMessages,
  estimateMessageTokens,
  TokenTracker,
  truncateToolResults,
  ttlPrune,
} from './defense'
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output'

let seq = 0
function userMsg(text: string): ModelMessage {
  return { role: 'user', content: text }
}
function toolMsg(text: string, output?: ReturnType<typeof textToolResultOutput>): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: `call-${seq++}`,
        toolName: 'read_file',
        output: output ?? textToolResultOutput(text),
      },
    ],
  }
}
function errorToolMsg(text: string): ModelMessage {
  return toolMsg(text, { type: 'error-text', value: text })
}

/** 取 tool 消息第一个 part 的输出文本 */
function outputAt(messages: ModelMessage[], idx: number): string {
  const msg = messages[idx]
  if (msg.role !== 'tool') throw new Error(`messages[${idx}] 不是 tool 消息`)
  return toolResultOutputToText(msg.content[0].output)
}

/** 全部 tool 消息的下标（构造 TTL 场景用） */
function toolIndicesOf(messages: ModelMessage[]): number[] {
  return messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0)
}

describe('estimateMessageTokens', () => {
  it('字符串 content 按 4 字符/token × 1.2 估算', () => {
    expect(estimateMessageTokens([userMsg('abcd')])).toBe(2) // ceil(1 × 1.2)
    expect(estimateMessageTokens([userMsg('a'.repeat(400))])).toBe(120)
  })

  it('统计工具输出与 tool-call 入参', () => {
    const msgs: ModelMessage[] = [
      toolMsg('a'.repeat(40)),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: { a: 'b'.repeat(36) } },
        ],
      },
    ]
    // 40（工具输出）+ 44（JSON.stringify({"a":"…36b…"})）= 84 字符 → ceil(21 × 1.2) = 26
    expect(estimateMessageTokens(msgs)).toBe(26)
  })
})

describe('TokenTracker', () => {
  it('锚定 + 增量 + 对账', () => {
    const tracker = new TokenTracker()
    expect(tracker.estimatedTokens).toBe(0)

    tracker.addMessage(userMsg('abcd')) // 4 字符 → 1 token
    expect(tracker.estimatedTokens).toBe(1)

    tracker.updateFromAPI(1000) // 锚定后清零增量
    expect(tracker.estimatedTokens).toBe(1000)

    tracker.addMessages([userMsg('abcd'), userMsg('abcd')]) // +8 字符 → +2
    expect(tracker.estimatedTokens).toBe(1002)

    // 压缩对账：数组从 8 字符缩到 4 字符 → -1
    tracker.replaceMessages([userMsg('x'.repeat(8))], [userMsg('x'.repeat(4))])
    expect(tracker.estimatedTokens).toBe(1001)
  })

  it('status：75% 窗口占用触发 needsAction', () => {
    const tracker = new TokenTracker()
    tracker.updateFromAPI(150_000)
    expect(tracker.status).toEqual({ tokens: 150_000, percent: 75, needsAction: true })
    tracker.updateFromAPI(100_000)
    expect(tracker.status.needsAction).toBe(false)
  })
})

describe('truncateToolResults', () => {
  it('超长结果被截断（头尾保留）', () => {
    const result = truncateToolResults([toolMsg('x'.repeat(200_001))])
    expect(result.truncated).toBe(1)
    const output = outputAt(result.messages, 0)
    expect(output).toContain('[省略')
    expect(output.length).toBeLessThan(200_001 + 100)
    expect(output.startsWith('x'.repeat(100))).toBe(true) // 头部保留
  })

  it('错误结果豁免截断', () => {
    const result = truncateToolResults([errorToolMsg('e'.repeat(200_001))])
    expect(result.truncated).toBe(0)
    expect(outputAt(result.messages, 0)).toBe('e'.repeat(200_001))
  })

  it('总预算超限时从最老开始清，错误结果豁免', () => {
    const messages = [
      errorToolMsg('e'.repeat(400_000)), // 0：错误，豁免
      toolMsg('x'.repeat(100_001)), // 1：最老的非错误 → 清
      toolMsg('y'.repeat(100_001)), // 2：仍超预算 → 清
      toolMsg('z'.repeat(100_001)), // 3：保留
    ]
    const result = truncateToolResults(messages)
    expect(result.compacted).toBe(2)
    expect(outputAt(result.messages, 0)).toBe('e'.repeat(400_000))
    expect(outputAt(result.messages, 1)).toBe('[compacted: 为腾出上下文预算已清除]')
    expect(outputAt(result.messages, 2)).toBe('[compacted: 为腾出上下文预算已清除]')
    expect(outputAt(result.messages, 3)).toContain('z'.repeat(10))
  })
})

describe('ttlPrune', () => {
  const MIN = 60 * 1000

  it('时间戳与消息数不一致时整体放弃（宁可漏修不可错修）', () => {
    const result = ttlPrune([toolMsg('x'.repeat(10_000))], [])
    expect(result.messages).toHaveLength(1)
    expect(result.softPruned).toBe(0)
    expect(result.hardPruned).toBe(0)
  })

  it('新鲜结果（< 5min）不修剪', () => {
    const messages = [toolMsg('x'.repeat(10_000))]
    const result = ttlPrune(messages, [Date.now() - 1 * MIN])
    expect(result.messages).toEqual(messages)
    expect(result.softPruned).toBe(0)
    expect(result.hardPruned).toBe(0)
  })

  it('软修剪（≥ 5min）：保留头尾，错误结果豁免', () => {
    const messages = [toolMsg('x'.repeat(10_000)), errorToolMsg('e'.repeat(10_000))]
    // 补足 3 个最近工具消息，让前两条脱离豁免窗口
    messages.push(toolMsg('a'), toolMsg('b'), toolMsg('c'))
    const timestamps = messages.map(() => Date.now() - 7 * MIN)

    const result = ttlPrune(messages, timestamps)

    expect(result.softPruned).toBe(1)
    expect(outputAt(result.messages, 0)).toContain('[soft pruned')
    expect(outputAt(result.messages, 0)).toMatch(/^x{1500}/) // 头保留
    expect(outputAt(result.messages, 1)).toBe('e'.repeat(10_000)) // 错误豁免
  })

  it('硬清空（≥ 10min）：错误结果同样清除', () => {
    const messages = [toolMsg('x'.repeat(10_000)), errorToolMsg('e'.repeat(10_000))]
    messages.push(toolMsg('a'), toolMsg('b'), toolMsg('c'))
    const timestamps = messages.map(() => Date.now() - 11 * MIN)

    const result = ttlPrune(messages, timestamps)

    expect(result.hardPruned).toBe(2)
    expect(outputAt(result.messages, 0)).toContain('expired')
    expect(outputAt(result.messages, 1)).toContain('expired')
  })

  it('最近 3 个工具结果豁免（与 microcompact 保留窗口对齐）', () => {
    const messages = Array.from({ length: 4 }, (_, i) => toolMsg(`x${i}`.repeat(5_000)))
    const timestamps = messages.map(() => Date.now() - 11 * MIN)

    const result = ttlPrune(messages, timestamps)

    const toolIdx = toolIndicesOf(result.messages)
    expect(result.hardPruned).toBe(1)
    expect(outputAt(result.messages, toolIdx[0])).toContain('expired')
    for (const idx of toolIdx.slice(-3)) {
      expect(outputAt(result.messages, idx)).not.toContain('expired')
    }
  })
})

describe('buildTimestampedMessages', () => {
  it('含工具调用的 assistant 消息展开为多条 ModelMessage，时间戳下标对齐', async () => {
    const dbTime = new Date('2026-10-21T10:00:00Z')
    const uiMessages: UIMessage[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '读文件' }] },
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolCallId: 'c1',
            toolName: 'read_file',
            state: 'output-available',
            input: { path: 'a.ts' },
            output: textToolResultOutput('文件内容'),
          },
        ],
      },
    ]
    const createdAtById = new Map([
      ['m1', dbTime],
      ['m2', dbTime],
    ])

    const { messages, timestamps } = await buildTimestampedMessages(uiMessages, createdAtById)

    // m2 展开为 assistant(tool-call) + tool(result) 两条
    expect(messages.length).toBeGreaterThanOrEqual(3)
    expect(timestamps).toHaveLength(messages.length)
    for (const ts of timestamps) expect(ts).toBe(dbTime.getTime())
    expect(messages.some((m) => m.role === 'tool')).toBe(true)
  })

  it('DB 中不存在的消息视为刚产生（不参与 TTL 修剪）', async () => {
    const before = Date.now()
    const { messages, timestamps } = await buildTimestampedMessages(
      [{ id: 'unknown', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      new Map(),
    )
    expect(timestamps[0]).toBeGreaterThanOrEqual(before)
    expect(messages[0].role).toBe('user')
  })
})

describe('applyDefense', () => {
  it('三层组合：截断 → TTL → 估算', () => {
    const messages = [toolMsg('x'.repeat(10_000)), toolMsg('a'), toolMsg('b'), toolMsg('c')]
    const timestamps = messages.map(() => Date.now() - 11 * 60 * 1000)

    const result = applyDefense(messages, timestamps)

    expect(result.hardPruned).toBe(1)
    expect(estimateMessageTokens(result.messages)).toBeLessThan(estimateMessageTokens(messages))
  })
})
