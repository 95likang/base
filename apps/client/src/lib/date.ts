/** 训练日期是 YYYY-MM-DD；按本地日历日比较，避免时区把「今天」算错 */
export function dayOffset(isoDate?: string, today = new Date()): number | null {
  if (!isoDate) return null
  const [year, month, day] = isoDate.split('-').map(Number)
  if (!year || !month || !day) return null
  const target = new Date(year, month - 1, day)
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((target.getTime() - base.getTime()) / 86_400_000)
}

/** 列表与详情共用的「今天 / 明天 / 已逾期 N 天」说法 */
export function relativeDay(isoDate?: string): { label: string; overdue: boolean } | null {
  const offset = dayOffset(isoDate)
  if (offset === null) return null
  if (offset === 0) return { label: '今天', overdue: false }
  if (offset === 1) return { label: '明天', overdue: false }
  if (offset === -1) return { label: '昨天', overdue: true }
  if (offset < -1) return { label: `已逾期 ${-offset} 天`, overdue: true }
  return { label: `还有 ${offset} 天`, overdue: false }
}
