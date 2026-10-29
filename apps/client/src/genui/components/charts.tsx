import type { BarChartData, LineChartData } from 'api/genui/spec'
import type { ReactNode } from 'react'
import { formatNumber } from './format'

const W = 320
const H = 140
const PAD = 6

function ChartFrame({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      {title ? <p className="mb-2 text-xs text-gray-500">{title}</p> : null}
      {children}
    </div>
  )
}

export function BarChart({ title, series }: BarChartData) {
  const values = series.map((point) => point.value)
  const max = Math.max(0, ...values)
  const min = Math.min(0, ...values)
  const span = max - min
  if (span === 0) {
    // 全部相同画出来只是一条贴底的平线（全 0 时甚至什么都看不到），
    // 所以说明「值相同」而不是断言「没有数据」——0 也是真实数据
    return (
      <ChartFrame title={title}>
        <p className="py-8 text-center text-xs text-gray-400">
          所有分类的值相同（{formatNumber(values[0] ?? 0)}），无法体现差异
        </p>
      </ChartFrame>
    )
  }

  const plotHeight = H - PAD * 2
  // 有负值时以 0 为基线：正柱向上、负柱向下，避免把负数画成 0 高度
  const zeroY = PAD + (max / span) * plotHeight
  const step = (W - PAD * 2) / series.length
  const barWidth = Math.max(2, step * 0.6)

  return (
    <ChartFrame title={title}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-36 w-full"
        role="img"
        aria-label={title ?? '分类对比柱状图'}
      >
        <line
          x1={PAD}
          y1={zeroY}
          x2={W - PAD}
          y2={zeroY}
          className="stroke-gray-300"
          strokeDasharray="3 3"
        />
        {series.map((point, i) => {
          const y = PAD + ((max - point.value) / span) * plotHeight
          const x = PAD + step * i + (step - barWidth) / 2
          return (
            <rect
              key={`${point.label}:${point.value}`}
              x={x}
              y={Math.min(y, zeroY)}
              width={barWidth}
              height={Math.max(1, Math.abs(zeroY - y))}
              rx={2}
              className={point.value >= 0 ? 'fill-blue-500' : 'fill-red-400'}
            >
              <title>{`${point.label}: ${formatNumber(point.value)}`}</title>
            </rect>
          )
        })}
      </svg>
      {series.length <= 12 ? (
        <div className="mt-1 flex gap-1 text-[11px] text-gray-600">
          {series.map((point) => (
            <span
              key={point.label}
              className="min-w-0 flex-1 truncate text-center"
              title={point.label}
            >
              {point.label}
            </span>
          ))}
        </div>
      ) : null}
    </ChartFrame>
  )
}

export function LineChart({ title, points }: LineChartData) {
  const values = points.map((point) => point.value)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const plotHeight = H - PAD * 2
  const coords = values.map((value, i) => ({
    x: PAD + (i / Math.max(1, values.length - 1)) * (W - PAD * 2),
    y: PAD + ((max - value) / span) * plotHeight,
  }))
  const first = points.at(0)
  const last = points.at(-1)

  return (
    <ChartFrame title={title}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-36 w-full"
        role="img"
        aria-label={title ?? '趋势折线图'}
      >
        <polyline
          points={coords.map((point) => `${point.x},${point.y}`).join(' ')}
          fill="none"
          className="stroke-blue-500"
          strokeWidth={2}
        />
        {coords.map((point, i) => (
          <circle key={point.x} cx={point.x} cy={point.y} r={2} className="fill-blue-500">
            <title>{`${points[i]?.label ?? ''}: ${formatNumber(values[i] ?? 0)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-gray-500">
        <span>{first?.label}</span>
        <span>{last?.label}</span>
      </div>
    </ChartFrame>
  )
}
