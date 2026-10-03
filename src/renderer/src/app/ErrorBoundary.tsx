import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../components/ui/Button'
import { CodeBlock } from '../components/ui/CodeBlock'

interface Props {
  children: ReactNode
  /** When this value changes the boundary resets (e.g. the active view). */
  resetKey?: string
  label?: string
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Renderer error', error, info.componentStack)
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div role="alert" data-testid="error-boundary" className="m-4 max-w-3xl border-l-2 border-tone-danger bg-surface-1 p-4">
        <div className="mb-1 font-semibold text-tone-danger">{this.props.label ?? 'This view crashed'}</div>
        <p className="mb-2 text-fg-muted">The rest of NEXUS is unaffected. Details are also in the developer console.</p>
        <CodeBlock maxHeight={240}>{error.stack ?? error.message}</CodeBlock>
        <Button className="mt-3" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    )
  }
}
