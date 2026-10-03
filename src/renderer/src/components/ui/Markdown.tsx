import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from '../../lib/cn'

const SAFE_HREF = /^https?:\/\//i

// Links open via target=_blank, which the main process denies or hands to the OS. Anything that is not
// http(s) (javascript:, file:, relative) is rendered as plain text. Images are never loaded (CSP forbids
// remote images); the alt text is shown instead.
const components: Components = {
  a: ({ href, children }) =>
    href && SAFE_HREF.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="text-fg-faint">[image{alt ? `: ${alt}` : ''}]</span>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-auto whitespace-pre-wrap break-words rounded-[3px] border bg-surface-0 p-2 font-mono text-[0.92em]">
      {children}
    </pre>
  ),
  code: ({ children, className }) => (
    <code className={cn('font-mono text-[0.92em]', !className && 'rounded-[3px] bg-surface-2 px-1')}>{children}</code>
  ),
  p: ({ children }) => <p className="my-1.5">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mb-1 mt-3 text-[1.1rem] font-semibold">{children}</h3>,
  h2: ({ children }) => <h4 className="mb-1 mt-3 text-[1.05rem] font-semibold">{children}</h4>,
  h3: ({ children }) => <h5 className="mb-1 mt-2 font-semibold">{children}</h5>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 pl-3 text-fg-muted">{children}</blockquote>,
  table: ({ children }) => (
    <div className="my-2 overflow-auto">
      <table className="border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border px-2 py-0.5 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-0.5">{children}</td>,
}

/** The only way to render agent/user markdown: parsed by react-markdown, sanitized by rehype-sanitize. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('min-w-0 break-words', className)}>
      <ReactMarkdown rehypePlugins={[rehypeSanitize]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
