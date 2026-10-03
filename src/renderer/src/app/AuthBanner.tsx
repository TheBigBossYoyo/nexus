import type { ReactNode } from 'react'
import { API_KEY_WARNING } from '@shared/auth'
import { useAuthStatus } from '../lib/queries'
import { useUiStore } from '../store/ui'
import { Notice } from '../components/ui'

/** Full-width warnings under the top bar: sign-in needed, runtime problems, or an API key in the environment. */
export function AuthBanner() {
  const status = useAuthStatus().data
  const setView = useUiStore((s) => s.setView)
  if (!status) return null

  const open = (
    <button type="button" className="ml-2 text-accent underline underline-offset-2" onClick={() => setView('auth')}>
      Open authentication
    </button>
  )
  const notices: { key: string; node: ReactNode }[] = []

  if (status.state === 'authentication_required') {
    notices.push({
      key: 'auth',
      node: (
        <Notice tone="danger" title="Authentication required" data-testid="auth-banner">
          Sign in to Claude before starting a run.
          {open}
        </Notice>
      ),
    })
  } else if (status.state === 'runtime_unavailable' || status.state === 'sdk_error') {
    notices.push({
      key: 'runtime',
      node: (
        <Notice tone="danger" title={status.state === 'sdk_error' ? 'Claude SDK error' : 'Claude runtime unavailable'} data-testid="auth-banner">
          {status.error ?? 'The Claude runtime did not respond.'}
          {open}
        </Notice>
      ),
    })
  }

  if (status.apiKeyEnvDetected) {
    notices.push({
      key: 'api-key',
      node: (
        <Notice tone={status.apiKeyEnvStripped ? 'neutral' : 'warning'} title="API key in environment" data-testid="api-key-banner">
          {API_KEY_WARNING}
          {status.apiKeyEnvStripped ? ' Subscription Mode is on, so it is removed from agent environments.' : null}
        </Notice>
      ),
    })
  }

  if (notices.length === 0) return null
  return (
    <div className="flex shrink-0 flex-col gap-px">
      {notices.map((n) => (
        <div key={n.key}>{n.node}</div>
      ))}
    </div>
  )
}
