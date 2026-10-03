import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const THRESHOLD_PX = 24

/**
 * Keeps a scroll container pinned to the bottom while new content arrives. Scrolling up releases the pin;
 * scrolling back to the bottom (or calling `jumpToLatest`) re-engages it.
 */
export function useStickyScroll<T extends HTMLElement>(
  contentKey: unknown,
): { ref: RefObject<T | null>; pinned: boolean; onScroll: () => void; jumpToLatest: () => void } {
  const ref = useRef<T | null>(null)
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(true)

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD_PX
    pinnedRef.current = atBottom
    setPinned(atBottom)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [contentKey])

  const jumpToLatest = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    pinnedRef.current = true
    setPinned(true)
  }, [])

  return { ref, pinned, onScroll, jumpToLatest }
}
