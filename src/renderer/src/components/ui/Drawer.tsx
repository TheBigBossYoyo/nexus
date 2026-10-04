import { useId, useRef, type ReactNode } from 'react'
import { IconButton } from './Button'
import { XIcon } from './icons'
import { useModal } from './useModal'

/** Right-side drawer. Esc and the scrim close it; focus is trapped while it is open. */
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
  const titleId = useId()
  useModal(ref, open, onClose)

  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="scrim anim-fade absolute inset-0" onClick={onClose} aria-hidden="true" />
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        style={{ width }}
        className="anim-slide relative flex h-full max-w-full flex-col border-l border-border-strong bg-surface-elevated shadow-elevated outline-none"
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b px-4">
          <h2 id={titleId} className="m-0 text-heading font-semibold">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose} size="sm">
            <XIcon />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </aside>
    </div>
  )
}
