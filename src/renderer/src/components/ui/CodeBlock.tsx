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
        'm-0 overflow-auto rounded-[3px] border bg-surface-0 p-2 font-mono text-[0.92em] leading-snug',
        wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
        className,
      )}
    >
      <code>{children}</code>
    </pre>
  )
}

export function InlineCode({ children, className }: { children: string; className?: string }) {
  return <code className={cn('rounded-[3px] bg-surface-2 px-1 font-mono text-[0.92em]', className)}>{children}</code>
}
