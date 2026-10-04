import { useEffect, useId, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

const CONTROL =
  'w-full rounded-[3px] border border-border-strong bg-surface-2 px-2 text-fg placeholder:text-fg-faint ' +
  'hover:border-fg-faint disabled:cursor-not-allowed disabled:opacity-50'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, 'h-[var(--row-h)]', className)} {...rest} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL, 'resize-y py-1.5 leading-snug', className)} {...rest} />
}

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
  testId?: string
}

/** Native select: keyboard and screen-reader friendly, and drivable by Playwright's selectOption. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  disabled,
  ...rest
}: {
  value: T
  onChange: (value: T) => void
  options: readonly SelectOption<T>[]
  className?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'data-testid'?: string
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(CONTROL, 'h-[var(--row-h)] pr-1', className)}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} className="bg-surface-2" data-testid={o.testId}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
  ...rest
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
  'data-testid'?: string
  'aria-label'?: string
}) {
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-4 w-7 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface-3',
        )}
        {...rest}
      >
        <span
          className={cn(
            'absolute top-px size-3 rounded-full transition-all',
            checked ? 'left-[13px] bg-accent-fg' : 'left-px bg-fg-muted',
          )}
        />
      </button>
      {label || description ? (
        <div className="min-w-0">
          {label ? <div className="leading-5">{label}</div> : null}
          {description ? <div className="text-[0.85rem] text-fg-muted">{description}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

/** Integer/decimal input that keeps its own text while typing and commits only valid numbers. */
export function NumberField({
  value,
  onChange,
  min,
  max,
  className,
  disabled,
  ...rest
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  className?: string
  disabled?: boolean
  id?: string
  'data-testid'?: string
  'aria-label'?: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    // Re-sync when the parent changes the value to something the text no longer represents.
    setText((t) => (Number(t) === value && t.trim() !== '' ? t : String(value)))
  }, [value])
  return (
    <Input
      type="number"
      inputMode="numeric"
      value={text}
      min={min}
      max={max}
      disabled={disabled}
      className={cn('font-mono', className)}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n)
      }}
      onBlur={() => setText(String(value))}
      {...rest}
    />
  )
}

/** Label + control + hint/error, with the label bound to the control. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | undefined
  children: (id: string) => ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[0.85rem] font-medium text-fg-muted">
        {label}
      </label>
      {children(id)}
      {error ? (
        <div role="alert" className="text-[0.85rem] text-tone-danger">
          {error}
        </div>
      ) : hint ? (
        <div className="text-[0.85rem] text-fg-faint">{hint}</div>
      ) : null}
    </div>
  )
}
