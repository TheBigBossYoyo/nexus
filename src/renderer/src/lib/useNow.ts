import { useEffect, useState } from 'react'

/** Wall-clock ms that re-renders the caller every `intervalMs` while `active`. Use for countdowns derived from timestamps. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs])
  return now
}
