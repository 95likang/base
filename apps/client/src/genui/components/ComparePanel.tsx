import type { ComparePanelData } from 'api/genui/spec'
import { formatNumber } from './format'

/** 两项并排：只适合两个值，三项及以上应改用 BarChart */
export function ComparePanel({ title, left, right }: ComparePanelData) {
  const items = [
    { key: 'left', ...left },
    { key: 'right', ...right },
  ]
  return (
    <div className="rounded-md border-2 border-border bg-card p-4">
      {title ? <p className="mb-2 text-xs text-muted-foreground">{title}</p> : null}
      <div className="grid grid-cols-2 gap-3">
        {items.map((item) => (
          <div key={item.key} className="rounded-sm bg-muted/50 px-3 py-2 text-center tabular-nums">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="mt-1 text-lg font-medium">
              {formatNumber(item.value)}
              {item.unit ? (
                <span className="ml-1 text-xs text-muted-foreground">{item.unit}</span>
              ) : null}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
