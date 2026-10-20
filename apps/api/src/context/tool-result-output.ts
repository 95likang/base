/**
 * ToolResultOutput 的构造与拍平工具：
 * 压缩器需要把任意形状的工具输出替换为占位符 / 提取为纯文本。
 */
import type { ToolResultPart } from 'ai'

type ToolResultOutput = ToolResultPart['output']

export function textToolResultOutput(value: string): ToolResultOutput {
  return { type: 'text', value }
}

export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'content':
      return output.value.map((part) => (part.type === 'text' ? part.text : '[media]')).join('\n')
    case 'execution-denied':
      return `[execution denied${output.reason ? `: ${output.reason}` : ''}]`
  }
}
