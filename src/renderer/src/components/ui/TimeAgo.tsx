import { useEffect, useState } from 'react'
import { formatDateTime, formatRelative } from '../../lib/format'

/** Relative time that re-renders every 30s. The absolute time is in the tooltip. */
export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  return (
    <time dateTime={iso ?? undefined} title={formatDateTime(iso)} className={className}>
      {formatRelative(iso)}
    </time>
  )
}
