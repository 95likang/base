import { z } from 'zod'

/**
 * 生成式 UI 组件参数规格。
 *
 * 服务端（工具 schema）与前端（渲染前校验）共用这一份定义：
 * 模型输出等于外部输入，前端只能使用 validateRenderInput 的重建结果，
 * 不允许把 part.input 直接透传给组件。
 */

/** 标签长度上限：模型输出不可信，所有上限写在 schema 里而不是 description 里 */
const label = z.string().min(1).max(40)
/** zod 4 的 number 默认拒绝 NaN / Infinity（旧版 .finite() 已废弃为 no-op） */
const finiteNumber = z.number()
const title = z.string().max(60).optional()
const unit = z.string().max(10).optional()

const seriesPoint = z.object({ label, value: finiteNumber })

const metricCardSchema = z.object({
  label,
  value: finiteNumber,
  delta: finiteNumber.optional(),
  unit,
})

const barChartSchema = z.object({
  title,
  series: z.array(seriesPoint).min(1).max(50),
})

const lineChartSchema = z.object({
  title,
  points: z.array(seriesPoint).min(1).max(200),
})

const tableSchema = z.object({
  columns: z.array(z.string().min(1).max(40)).min(1).max(12),
  /** 单元格只允许字符串/数字；对象或数组会被拒绝，避免把任意结构画进表格 */
  rows: z.array(z.array(z.union([z.string().max(200), finiteNumber]))).max(200),
  pageSize: z.number().int().min(1).max(100).optional(),
})

const compareItem = z.object({ label, value: finiteNumber, unit })

const comparePanelSchema = z.object({
  title,
  left: compareItem,
  right: compareItem,
})

const calloutSchema = z.object({
  text: z.string().min(1).max(200),
  level: z.enum(['info', 'warn', 'danger', 'success']).optional(),
})

/**
 * 工具目录：name → 参数 schema + description。
 * description 是模型唯一的判断依据，用途相近的工具必须写明「什么情况用另一个」。
 */
export const GENUI_TOOLS = {
  renderMetricCard: {
    description:
      '渲染单指标卡片（一个数值 + 可选环比 delta）。仅在用户只需要看单个汇总数值时使用；' +
      '多个分类对比用 renderBarChart，时序趋势用 renderLineChart。' +
      'value 必须是本轮工具查询得到的真实结果，不得推测或编造。',
    schema: metricCardSchema,
  },
  renderBarChart: {
    description:
      '渲染分类对比柱状图。仅在对比多个分类的数值时使用；' +
      '单一时序趋势用 renderLineChart，两项并排对比用 renderComparePanel。' +
      '数值必须来自本轮工具查询结果，不得推测或编造。',
    schema: barChartSchema,
  },
  renderLineChart: {
    description:
      '渲染时序趋势折线图。仅在数据按时间顺序排列、需要看走势时使用；' +
      '分类对比用 renderBarChart。数值必须来自本轮工具查询结果，不得推测或编造。',
    schema: lineChartSchema,
  },
  renderTable: {
    description:
      '渲染明细列表。仅在用户需要逐条查看记录时使用；只需要汇总数值用 renderMetricCard。' +
      'rows 每行的长度必须与 columns 一致，数值必须来自本轮工具查询结果。',
    schema: tableSchema,
  },
  renderComparePanel: {
    description:
      '渲染两项并排对比面板。仅在两项目标值需要并排比较时使用；' +
      '三项及以上分类对比用 renderBarChart。数值必须来自本轮工具查询结果。',
    schema: comparePanelSchema,
  },
  renderCallout: {
    description:
      '渲染一句结论或提醒并高亮。仅用于强调结论/风险，不用于展示数据；' +
      '需要展示数据时改用对应的图表或指标卡。',
    schema: calloutSchema,
  },
} as const

export type GenUIToolName = keyof typeof GENUI_TOOLS

/** 组件 props：前端组件直接复用，避免手写第二份类型 */
export type MetricCardData = z.infer<typeof metricCardSchema>
export type BarChartData = z.infer<typeof barChartSchema>
export type LineChartData = z.infer<typeof lineChartSchema>
export type TableData = z.infer<typeof tableSchema>
export type ComparePanelData = z.infer<typeof comparePanelSchema>
export type CalloutData = z.infer<typeof calloutSchema>

/** 显式白名单（禁止 import * 自动收集：新增组件必须在没人复核时也不会自动开放） */
export const GENUI_TOOL_NAMES = Object.keys(GENUI_TOOLS) as GenUIToolName[]

export function isGenUIToolName(name: string): name is GenUIToolName {
  return Object.hasOwn(GENUI_TOOLS, name)
}

/** 只有这两个状态才有完整的输入可以交给组件 */
export const RENDERABLE_PART_STATES = new Set(['input-available', 'output-available'])

export type GenUIValidation =
  | { ok: true; name: GenUIToolName; data: Record<string, unknown> }
  /** shape = 形状/上限不合法；semantic = 形状过了但画出来会误导 */
  | { ok: false; name: string; reason: 'shape' | 'semantic' }

/**
 * 校验模型输出并逐字段重建。
 * zod 的 safeParse 默认剥离 schema 未声明的字段，输出对象是全新构造的，
 * 因此可以安全地传给组件（不做 {...part.input} 透传）。
 */
export function validateRenderInput(name: string, input: unknown): GenUIValidation {
  if (!isGenUIToolName(name)) return { ok: false, name, reason: 'shape' }

  const parsed = GENUI_TOOLS[name].schema.safeParse(input)
  if (!parsed.success) return { ok: false, name, reason: 'shape' }

  const data = parsed.data as Record<string, unknown>
  if (isMisleading(name, data)) return { ok: false, name, reason: 'semantic' }
  return { ok: true, name, data }
}

/**
 * 语义规则：形状合法但会被误读成正确结果的输入。
 * 判据：补值/放行之后屏幕给出的确定性不能超过手上真实信息的确定性。
 *
 * 注意只拦「一定会误导」的输入：0 是合法真实值，不能因为「缺失值会补 0」就拒绝真 0
 * （字段缺失已被 schema 挡在形状校验）。
 */
function isMisleading(name: GenUIToolName, data: Record<string, unknown>): boolean {
  if (name !== 'renderTable') return false
  const columns = data.columns as string[]
  const rows = data.rows as (string | number)[][]
  // 行列数不一致会错位，画出来长得正常但数据全串行
  return rows.some((row) => row.length !== columns.length)
}

/** zod schema → AI SDK 可消费的 JSON Schema（去掉 zod 附加的元信息字段） */
export function toJsonSchemaParameters(schema: z.ZodType): Record<string, unknown> {
  const json = schema.toJSONSchema() as Record<string, unknown>
  // ~standard 是不可删除的属性，用过滤构造新对象
  return Object.fromEntries(
    Object.entries(json).filter(([key]) => key !== '$schema' && key !== '~standard'),
  )
}
