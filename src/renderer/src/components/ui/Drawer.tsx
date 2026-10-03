import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { IconButton } from './Button'
import { XIcon } from './icons'

/** Right-side drawer. Esc and the scrim close it. */
export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 440,
  testId,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  width?: number
  testId?: string
}) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-label={typeof title === 'string' ? title : 'Drawer'}
        data-testid={testId}
        style={{ width }}
        className={cn('relative flex h-full max-w-full flex-col border-l border-border-strong bg-surface-1 shadow-xl outline-none')}
      >
        <header className="flex h-9 shrink-0 items-center justify-between border-b px-3">
          <h2 className="font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <XIcon />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </aside>
    </div>
  )
}
