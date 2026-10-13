import type { ToolDefinition } from '../lib/tool-registry'

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
