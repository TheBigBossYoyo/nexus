import { cn } from '../lib/cn'
import { IconButton } from '../components/ui/Button'
import { XIcon } from '../components/ui/icons'
import { useToastStore } from '../store/toasts'

const BORDER = {
  error: 'border-tone-danger',
  info: 'border-tone-active',
  success: 'border-tone-success',
} as const

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-3 right-3 z-[60] flex w-[26rem] max-w-[90vw] flex-col gap-1.5">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-testid={`toast-${t.kind}`}
          className={cn(
            'pointer-events-auto flex items-start gap-2 border border-l-2 bg-surface-2 px-3 py-2 shadow-lg',
            BORDER[t.kind],
          )}
        >
          <div className="min-w-0 flex-1 break-words">{t.message}</div>
          <IconButton label="Dismiss" onClick={() => dismiss(t.id)} className="-mr-1 -mt-0.5">
            <XIcon size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
