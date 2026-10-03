import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Spinner } from './EmptyState'

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md'

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-surface-2 border-border-strong text-fg hover:bg-surface-3',
  primary: 'bg-accent border-accent text-accent-fg hover:brightness-110',
  danger: 'bg-transparent border-tone-danger/60 text-tone-danger hover:bg-tone-danger/12',
  ghost: 'bg-transparent border-transparent text-fg-muted hover:bg-surface-3 hover:text-fg',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-6 px-2 text-[0.85rem] gap-1',
  md: 'h-[var(--row-h)] px-2.5 gap-1.5',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={12} /> : icon}
      {children}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only buttons must be nameable. */
  label: string
  variant?: ButtonVariant
  children: ReactNode
}

export function IconButton({ label, variant = 'ghost', className, children, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-[3px] border transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
