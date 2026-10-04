import { cn } from '../../lib/cn'

/** Monospace text block. Content is rendered as a React text node, never as HTML. */
export function CodeBlock({
  children,
  wrap = true,
  maxHeight,
  className,
}: {
  children: string
  wrap?: boolean
  maxHeight?: number | string
  className?: string
}) {
  return (
    <pre
      style={{ maxHeight }}
      className={cn(
        'm-0 overflow-auto rounded-md border bg-surface-muted p-3 font-mono text-code leading-snug',
        wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
        className,
      )}
    >
      <code>{children}</code>
    </pre>
  )
}

export function InlineCode({ children, className }: { children: string; className?: string }) {
  return <code className={cn('rounded-sm bg-surface-hover px-1 font-mono text-code', className)}>{children}</code>
}
