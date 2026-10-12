import { tool } from 'ai'
import { z } from 'zod'

/** 模拟天气数据（真实场景应替换为调用天气 API） */
const MOCK_WEATHER: Record<string, { temperature: number; condition: string }> = {
  北京: { temperature: 18, condition: '晴' },
  上海: { temperature: 23, condition: '多云' },
  广州: { temperature: 28, condition: '阵雨' },
  深圳: { temperature: 27, condition: '阴' },
  杭州: { temperature: 22, condition: '晴转多云' },
}

/** 模拟天气工具：按城市查询天气，未收录的城市返回随机数据 */
export const weatherTool = tool({
  description: '查询指定城市的当前天气（温度、天气状况）',
  inputSchema: z.object({
    city: z.string().describe('城市名，如"北京"'),
  }),
  execute: async ({ city }) => {
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
})
