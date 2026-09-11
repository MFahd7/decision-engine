/** Shared formatting, so the kernel's prose and the UI's labels never disagree. */

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

/** '$1,240' for USD, '1,840 users affected' for anything else. */
export function quantity(value: number, unit: string): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  const withSeparators = rounded.toLocaleString('en-US', {
    maximumFractionDigits: value >= 100 ? 0 : 2,
  })
  if (unit === 'USD') return `$${withSeparators}`
  return `${withSeparators} ${unit}`
}

/** '41 days', '6 hours', '4 minutes', 'just now'. */
export function age(seconds: number): string {
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(seconds / 3600)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(seconds / 86400)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** Human label for a signal name: 'return_received_at_warehouse' -> 'return received at warehouse'. */
export function humanise(name: string): string {
  return name.replace(/_/g, ' ')
}
