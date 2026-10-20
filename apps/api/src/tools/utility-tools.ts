import type { ToolDefinition } from './registry'

/** 表达式长度上限：LLM 输出不可信，超长输入直接拒绝，不进入解析器 */
const MAX_EXPRESSION_LENGTH = 500

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

/**
 * 计算器工具：只读、并发安全（纯计算，无副作用）。
 * 输入长度在 execute 内再防御一次——JSON Schema 的 maxLength
 * 只是给模型看的声明，不能依赖它做运行时兜底。
 */
export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: '计算数学表达式，支持 + - * / % 和括号，如 "(1 + 2) * 3"。需要精确数值计算时使用。',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        maxLength: MAX_EXPRESSION_LENGTH,
        description: '算术表达式，如 "1.5 * (2 + 3)"',
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 1000,
  execute: async (input: { expression: string }) => {
    const { expression } = input
    try {
      if (expression.length > MAX_EXPRESSION_LENGTH) {
        return { expression: `${expression.slice(0, 50)}…`, error: '表达式过长' }
      }
      const result = evaluateExpression(expression)
      return { expression, result }
    } catch (err) {
      return {
        expression,
        error: err instanceof Error ? err.message : '表达式无效',
      }
    }
  },
}

/** 模拟天气数据（真实场景应替换为调用天气 API） */
const MOCK_WEATHER: Record<string, { temperature: number; condition: string }> = {
  北京: { temperature: 18, condition: '晴' },
  上海: { temperature: 23, condition: '多云' },
  广州: { temperature: 28, condition: '阵雨' },
  深圳: { temperature: 27, condition: '阴' },
  杭州: { temperature: 22, condition: '晴转多云' },
}

/**
 * 天气查询工具：只读、并发安全（纯查询，无副作用，可与同批工具并行执行）。
 * 结果很小，maxResultChars 收紧到 500 防止 mock 数据异常膨胀。
 */
export const weatherTool: ToolDefinition = {
  name: 'getWeather',
  description: '查询指定城市的当前天气（温度、天气状况）',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名，如"北京"' },
    },
    required: ['city'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500,
  execute: async (input: { city: string }) => {
    const { city } = input
    const known = Object.keys(MOCK_WEATHER).find((k) => city.includes(k))
    if (known) {
      return { city: known, ...MOCK_WEATHER[known] }
    }
    return {
      city,
      temperature: 15 + Math.floor(Math.random() * 15),
      condition: ['晴', '多云', '阴', '小雨'][Math.floor(Math.random() * 4)],
    }
  },
}
