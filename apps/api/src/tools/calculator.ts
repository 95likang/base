import { tool } from 'ai'
import { z } from 'zod'

/**
 * 四则运算解析器（递归下降）。
 * 不用 eval：表达式来自 LLM，即使加了正则过滤也不可靠。
 * 支持 + - * / % ( ) 和小数，忽略空白。
 */
function evaluateExpression(expr: string): number {
  let pos = 0

  const peek = () => expr.charAt(pos)
  const skipSpaces = () => {
    while (pos < expr.length && /\s/.test(expr.charAt(pos))) pos++
  }

  // expr := term (('+' | '-') term)*
  const parseExpr = (): number => {
    let value = parseTerm()
    skipSpaces()
    while (peek() === '+' || peek() === '-') {
      const op = expr.charAt(pos++)
      const rhs = parseTerm()
      value = op === '+' ? value + rhs : value - rhs
      skipSpaces()
    }
    return value
  }

  // term := factor (('*' | '/' | '%') factor)*
  const parseTerm = (): number => {
    let value = parseFactor()
    skipSpaces()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = expr.charAt(pos++)
      const rhs = parseFactor()
      if ((op === '/' || op === '%') && rhs === 0) {
        throw new Error('除数为零')
      }
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs
      skipSpaces()
    }
    return value
  }

  // factor := number | '(' expr ')' | ('-' | '+') factor
  const parseFactor = (): number => {
    skipSpaces()
    const ch = peek()
    if (ch === '(') {
      pos++
      const value = parseExpr()
      skipSpaces()
      if (peek() !== ')') throw new Error('括号不匹配')
      pos++
      return value
    }
    if (ch === '-' || ch === '+') {
      pos++
      const value = parseFactor()
      return ch === '-' ? -value : value
    }
    const start = pos
    while (pos < expr.length && /[\d.]/.test(expr.charAt(pos))) pos++
    if (start === pos) throw new Error(`无法解析: "${expr.slice(pos)}"`)
    const num = Number(expr.slice(start, pos))
    if (Number.isNaN(num)) throw new Error(`无效数字: "${expr.slice(start, pos)}"`)
    return num
  }

  const result = parseExpr()
  skipSpaces()
  if (pos < expr.length) throw new Error(`多余字符: "${expr.slice(pos)}"`)
  return result
}

/** 计算器工具：求值四则运算表达式 */
export const calculatorTool = tool({
  description: '计算数学表达式，支持 + - * / % 和括号，如 "(1 + 2) * 3"。需要精确数值计算时使用。',
  inputSchema: z.object({
    expression: z.string().max(500).describe('算术表达式，如 "1.5 * (2 + 3)"'),
  }),
  execute: async ({ expression }) => {
    try {
      const result = evaluateExpression(expression)
      return { expression, result }
    } catch (err) {
      return {
        expression,
        error: err instanceof Error ? err.message : '表达式无效',
      }
    }
  },
})
