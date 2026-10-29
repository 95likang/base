import type { MetricCardData } from 'api/genui/spec'
import { formatNumber } from './format'

/** 单指标 + 环比：数字用 tabular-nums，位数变化不改变行高/列宽 */
export function MetricCard({ label, value, delta, unit }: MetricCardData) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 flex items-baseline gap-1 tabular-nums">
        <span className="text-2xl font-semibold">{formatNumber(value)}</span>
        {unit ? <span className="text-xs text-gray-500">{unit}</span> : null}
      </p>
      {delta !== undefined ? (
        <p
          className={`mt-1 text-xs tabular-nums ${delta >= 0 ? 'text-green-600' : 'text-red-600'}`}
        >
          环比 {delta >= 0 ? '+' : ''}
          {formatNumber(delta)}
          {unit ?? ''}
        </p>
      ) : null}
    </div>
  )
}
