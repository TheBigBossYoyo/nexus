/** Formatters never invent values: null/undefined/NaN always render as the em dash. */
export const DASH = '—'

function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

export function formatDuration(ms: number | null | undefined): string {
  if (!isNum(ms) || ms < 0) return DASH
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Duration between two ISO timestamps; an unfinished span runs until `now`. */
export function formatSpan(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!startIso) return DASH
  const start = Date.parse(startIso)
  const end = endIso ? Date.parse(endIso) : now
  return Number.isNaN(start) || Number.isNaN(end) ? DASH : formatDuration(end - start)
}

export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return DASH
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return DASH
  const diff = now - t
  const abs = Math.abs(diff)
  if (abs < 5_000) return 'just now'
  const unit =
    abs < 60_000
      ? `${Math.floor(abs / 1000)}s`
      : abs < 3_600_000
        ? `${Math.floor(abs / 60_000)}m`
        : abs < 86_400_000
          ? `${Math.floor(abs / 3_600_000)}h`
          : abs < 30 * 86_400_000
            ? `${Math.floor(abs / 86_400_000)}d`
            : null
  if (unit === null) return formatDate(iso)
  return diff >= 0 ? `${unit} ago` : `in ${unit}`
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  return `${formatDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '')
}

export function formatTokens(n: number | null | undefined): string {
  if (!isNum(n) || n < 0) return DASH
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${trim(n / 1000)}k`
  return `${trim(n / 1_000_000)}M`
}

export function formatCost(usd: number | null | undefined): string {
  if (!isNum(usd) || usd < 0) return DASH
  if (usd === 0) return '$0.00'
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!isNum(bytes) || bytes < 0) return DASH
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatCount(n: number | null | undefined): string {
  return isNum(n) ? n.toLocaleString('en-US') : DASH
}

/** First 8 hex chars of an id (same rule as shortId in @shared/ids). */
export function shortId(id: string | null | undefined): string {
  return id ? id.replace(/-/g, '').slice(0, 8) : DASH
}

/** Last path segment for display, handling both separators. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
