import { useEffect, useRef, type ReactNode } from 'react'
import { Button, IconButton } from './Button'
import { XIcon } from './icons'

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
  testId,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: number
  testId?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Focus the first control if there is one, otherwise the dialog itself.
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button[data-autofocus]')
    ;(first ?? ref.current)?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        style={{ width }}
        className="relative flex max-h-[76vh] max-w-[94vw] flex-col border border-border-strong bg-surface-1 shadow-xl outline-none"
      >
        <header className="flex h-9 shrink-0 items-center justify-between border-b px-3">
          <h2 className="font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <XIcon />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
        {footer ? <footer className="flex shrink-0 justify-end gap-2 border-t px-3 py-2">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  danger = false,
  loading = false,
  testId,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  children: ReactNode
  confirmLabel?: string
  danger?: boolean
  loading?: boolean
  testId?: string
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      testId={testId}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
            data-autofocus
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-fg-muted">{children}</div>
    </Dialog>
  )
}
