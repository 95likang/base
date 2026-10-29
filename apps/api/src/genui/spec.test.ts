import { describe, expect, it } from 'vitest'
import {
  GENUI_TOOL_NAMES,
  GENUI_TOOLS,
  isGenUIToolName,
  toJsonSchemaParameters,
  validateRenderInput,
} from './spec'

/** 各组件一条 golden 用例：形状合法、语义不误导、返回的是重建后的新对象 */
const GOLDEN_CASES: Array<[string, unknown]> = [
  ['renderMetricCard', { label: '近 30 天营收', value: 128_000, delta: 0.08, unit: '元' }],
  [
    'renderBarChart',
    {
      title: '各渠道营收',
      series: [
        { label: 'A', value: 10 },
        { label: 'B', value: 5 },
      ],
    },
  ],
  [
    'renderLineChart',
    {
      points: [
        { label: '10-01', value: 1 },
        { label: '10-02', value: 2 },
      ],
    },
  ],
  [
    'renderTable',
    {
      columns: ['渠道', '营收'],
      rows: [
        ['A', 10],
        ['B', 5],
      ],
    },
  ],
  [
    'renderComparePanel',
    { left: { label: '上周', value: 10 }, right: { label: '上上周', value: 9 } },
  ],
  ['renderCallout', { text: '退货率环比上升 3 个百分点', level: 'warn' }],
]

describe('生成式 UI 参数规格', () => {
  it('白名单固定为 6 个工具', () => {
    expect(GENUI_TOOL_NAMES).toHaveLength(6)
    expect(isGenUIToolName('renderMetricCard')).toBe(true)
    expect(isGenUIToolName('renderPieChart')).toBe(false)
  })

  it.each(GOLDEN_CASES)('%s 的 golden 用例通过', (name, input) => {
    const result = validateRenderInput(name, input)
    expect(result.ok).toBe(true)
  })

  it('未知字段被剥离，不透传模型输出', () => {
    const result = validateRenderInput('renderMetricCard', {
      label: '营收',
      value: 1,
      evil: '<script>alert(1)</script>',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ label: '营收', value: 1 })
    }
  })

  it('未注册 name 一律失败，不做模糊匹配', () => {
    expect(validateRenderInput('renderPieChart', {})).toEqual({
      ok: false,
      name: 'renderPieChart',
      reason: 'shape',
    })
  })

  it('空 series 形状失败（补空数组等于断言没有数据）', () => {
    expect(validateRenderInput('renderBarChart', { series: [] })).toMatchObject({
      ok: false,
      reason: 'shape',
    })
  })

  it('MetricCard 值为 0 → 正常渲染（0 是合法真实值）', () => {
    const result = validateRenderInput('renderMetricCard', { label: '营收', value: 0 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ label: '营收', value: 0 })
  })

  it('Table 行列数不一致 → 语义失败', () => {
    expect(
      validateRenderInput('renderTable', { columns: ['a', 'b'], rows: [['only-one']] }),
    ).toMatchObject({ ok: false, reason: 'semantic' })
  })

  it('超长 label 形状失败', () => {
    expect(
      validateRenderInput('renderMetricCard', { label: 'x'.repeat(41), value: 1 }),
    ).toMatchObject({ ok: false, reason: 'shape' })
  })

  it('工具参数转成干净的 JSON Schema', () => {
    for (const name of GENUI_TOOL_NAMES) {
      const parameters = toJsonSchemaParameters(GENUI_TOOLS[name].schema)
      expect(parameters.type).toBe('object')
      expect(parameters).not.toHaveProperty('~standard')
      expect(parameters).not.toHaveProperty('$schema')
    }
  })
})
