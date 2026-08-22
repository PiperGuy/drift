export function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.round((ms - now) / 1000)
  const abs = Math.abs(s)
  if (abs < 60) return rtf.format(s, 'second')
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day')
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' })
}
