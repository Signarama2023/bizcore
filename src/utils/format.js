/**
 * Format a number as USD with no decimals. Returns "—" for null / NaN.
 * Used across BizCore for all dollar-value displays.
 */
export function fmt(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const num = Number(n)
  const sign = num < 0 ? '-' : ''
  return `${sign}$${Math.abs(num).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
