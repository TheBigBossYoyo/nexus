import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Spinner } from './EmptyState'

export type ButtonVariant = 'default' | 'secondary' | 'primary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md'

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-surface border-border-strong text-text-primary hover:bg-surface-muted active:bg-surface-hover',
  secondary: 'bg-surface border-border-strong text-text-primary hover:bg-surface-muted active:bg-surface-hover',
  primary: 'bg-accent border-accent text-accent-fg hover:bg-accent-hover hover:border-accent-hover',
  danger: 'bg-surface border-danger/40 text-danger hover:bg-danger-subtle',
  ghost: 'bg-transparent border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-6 px-2 text-small gap-1',
  md: 'h-[var(--control-h)] px-3 text-body gap-1.5',
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
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={12} className="text-current" /> : icon}
      {children}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only buttons must be nameable. */
  label: string
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
}

export function IconButton({ label, variant = 'ghost', size = 'md', className, children, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md border transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'size-6' : 'size-7',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
