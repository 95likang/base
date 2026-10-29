/** 卡片里的数字统一走这里：固定小数位 + 千分位，避免 128 → 1280 时宽度跳变 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
}
