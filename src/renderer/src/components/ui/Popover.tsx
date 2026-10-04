import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'

export interface PopoverTriggerProps {
  ref: (el: HTMLElement | null) => void
  onClick: () => void
  'aria-expanded': boolean
  'aria-haspopup': 'dialog'
  'aria-controls': string | undefined
}

/**
 * Anchored popover rendered in a portal with fixed positioning, so it is never clipped by a scrolling or
 * overflow-hidden ancestor. Closes on Esc and outside press. Focus moves into it and returns to the trigger.
 *
 *   <Popover content={<div>…</div>} align="end" testId="usage-popover">
 *     {(p) => <button {...p}>Claude</button>}
 *   </Popover>
 */
export function Popover({
  children,
  content,
  side = 'bottom',
  align = 'start',
  width = 320,
  label,
  testId,
  open: controlledOpen,
  onOpenChange,
  className,
}: {
  children: (props: PopoverTriggerProps) => ReactNode
  content: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  width?: number
  /** Accessible name of the popover panel. */
  label: string
  testId?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}) {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = controlledOpen ?? innerOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setInnerOpen(next)
      onOpenChange?.(next)
    },
    [controlledOpen, onOpenChange],
  )
  const triggerRef = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const id = useId()

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect()
      if (!t) return
      const w = Math.min(width, window.innerWidth - 16)
      const rawLeft = align === 'end' ? t.right - w : t.left
      const left = Math.max(8, Math.min(rawLeft, window.innerWidth - w - 8))
      setPos(
        side === 'bottom'
          ? { left, top: t.bottom + 6 }
          : { left, bottom: window.innerHeight - t.top + 6 },
      )
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, side, align, width])

  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    panelRef.current?.focus()
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || trigger?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        trigger?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, setOpen])

  return (
    <>
      {children({
        ref: (el) => {
          triggerRef.current = el
        },
        onClick: () => setOpen(!open),
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        'aria-controls': open ? id : undefined,
      })}
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              id={id}
              role="dialog"
              aria-label={label}
              tabIndex={-1}
              data-testid={testId}
              style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width }}
              className={cn(
                'anim-pop fixed z-50 max-w-[calc(100vw-16px)] rounded-lg border border-border-strong bg-surface-elevated text-body shadow-elevated outline-none',
                className,
              )}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
