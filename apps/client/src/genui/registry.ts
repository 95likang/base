import type { GenUIToolName } from 'api/genui/spec'
import type { ComponentType } from 'react'
import { Callout } from './components/Callout'
import { ComparePanel } from './components/ComparePanel'
import { BarChart, LineChart } from './components/charts'
import { MetricCard } from './components/MetricCard'
import { Table } from './components/Table'

/**
 * 显式白名单：key 与工具名同名，禁止 import * 自动收集。
 * 自动收集会让新增组件在没人复核的情况下直接对模型开放。
 *
 * 新增组件必须同时提交：组件实现、schema（genui/spec.ts）、description、一条 golden 用例。
 * 结构不兼容时新增 name（如 renderMetricCard2），旧的在注册表里保留至少一个发布周期。
 */
// biome-ignore lint/suspicious/noExplicitAny: 各组件 props 形状不同，注册表只做名字到组件的映射
export const registry: Record<GenUIToolName, ComponentType<any>> = {
  renderMetricCard: MetricCard,
  renderBarChart: BarChart,
  renderLineChart: LineChart,
  renderTable: Table,
  renderComparePanel: ComparePanel,
  renderCallout: Callout,
}
