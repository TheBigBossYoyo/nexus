import { cn } from '../lib/cn'
import { IconButton } from '../components/ui/Button'
import { AlertIcon, CircleCheckIcon, InfoIcon, XIcon } from '../components/ui/icons'
import { useToastStore, type ToastKind } from '../store/toasts'

const STYLE: Record<ToastKind, { bar: string; icon: string }> = {
  error: { bar: 'bg-danger', icon: 'text-danger' },
  info: { bar: 'bg-info', icon: 'text-info' },
  success: { bar: 'bg-success', icon: 'text-success' },
  notice: { bar: 'bg-warning', icon: 'text-warning' },
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'success') return <CircleCheckIcon size={14} />
  if (kind === 'info') return <InfoIcon size={14} />
  return <AlertIcon size={14} />
}

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[24rem] max-w-[90vw] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-testid={`toast-${t.kind}`}
          className="anim-pop pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-lg border border-border-strong bg-surface-elevated py-2.5 pl-4 pr-2 shadow-elevated"
        >
          <span
            aria-hidden="true"
            className={cn('absolute inset-y-0 left-0 w-1', STYLE[t.kind].bar)}
          />
          <span className={cn('mt-0.5 shrink-0', STYLE[t.kind].icon)}>
            <ToastIcon kind={t.kind} />
          </span>
          <div className="min-w-0 flex-1 break-words">
            <div className={cn(t.detail && 'font-semibold')}>{t.message}</div>
            {t.detail ? <div className="text-small text-text-secondary">{t.detail}</div> : null}
          </div>
          <IconButton label="Dismiss" onClick={() => dismiss(t.id)} size="sm">
            <XIcon size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
