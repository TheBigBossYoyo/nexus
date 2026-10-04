import { useId, useRef, type ReactNode } from 'react'
import { Button, IconButton } from './Button'
import { XIcon } from './icons'
import { useModal } from './useModal'

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
  const titleId = useId()
  useModal(ref, open, onClose, 'input, textarea, select, button[data-autofocus]')

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <div className="scrim anim-fade absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        style={{ width }}
        className="anim-pop relative flex max-h-[76vh] max-w-[94vw] flex-col rounded-lg border border-border-strong bg-surface-elevated shadow-elevated outline-none"
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b px-4">
          <h2 id={titleId} className="m-0 text-heading font-semibold">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose} size="sm">
            <XIcon />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer ? <footer className="flex shrink-0 justify-end gap-2 border-t px-4 py-3">{footer}</footer> : null}
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
      <div className="text-text-secondary">{children}</div>
    </Dialog>
  )
}
