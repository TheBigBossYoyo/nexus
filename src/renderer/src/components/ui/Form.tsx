import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '../../lib/cn'

const CONTROL =
  'w-full rounded-md border border-control-border bg-surface px-2.5 text-text-primary placeholder:text-text-muted ' +
  'hover:border-text-muted disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60'

/**
 * What a Field says about the control inside it: the element that describes it (its hint or its error) and
 * whether it is in error. The controls below read it, so a screen reader hears the hint and the error with
 * the control and not only somewhere near it.
 */
const FieldContext = createContext<{ describedBy?: string; invalid?: boolean }>({})

function useFieldAria(): { 'aria-describedby'?: string; 'aria-invalid'?: true } {
  const field = useContext(FieldContext)
  return { ...(field.describedBy ? { 'aria-describedby': field.describedBy } : {}), ...(field.invalid ? { 'aria-invalid': true as const } : {}) }
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, 'h-[var(--control-h)]', className)} {...useFieldAria()} {...rest} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL, 'resize-y py-1.5 leading-snug', className)} {...useFieldAria()} {...rest} />
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
  const aria = useFieldAria()
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(CONTROL, 'h-[var(--control-h)] pr-1', className)}
      {...aria}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} data-testid={o.testId}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** Switch. Semantics are role="switch" + aria-checked on a real button, so it is keyboard operable. */
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
  // The switch is named by its label and described by its description, unless the caller names it itself.
  const id = useId()
  const named = rest['aria-label'] === undefined && Boolean(label)
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={named ? `${id}-label` : undefined}
        aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-px h-[18px] w-8 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-accent bg-accent' : 'border-control-border bg-surface-hover',
        )}
        {...rest}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-px size-3.5 rounded-full transition-[left]',
            checked ? 'bg-accent-fg' : 'bg-surface',
            checked ? 'left-[15px]' : 'left-px border border-border-strong',
          )}
        />
      </button>
      {label || description ? (
        <div className="min-w-0">
          {label ? (
            <div id={`${id}-label`} className="leading-5">
              {label}
            </div>
          ) : null}
          {description ? (
            <div id={`${id}-description`} className="text-small text-text-muted">
              {description}
            </div>
          ) : null}
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
      className={cn('font-mono tnum', className)}
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
  const describedBy = error || hint ? `${id}-note` : undefined
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-small font-medium text-text-secondary">
        {label}
      </label>
      <FieldContext.Provider value={{ ...(describedBy ? { describedBy } : {}), invalid: Boolean(error) }}>{children(id)}</FieldContext.Provider>
      {error ? (
        <div role="alert" id={describedBy} className="text-small text-danger">
          {error}
        </div>
      ) : hint ? (
        <div id={describedBy} className="text-small text-text-muted">{hint}</div>
      ) : null}
    </div>
  )
}
