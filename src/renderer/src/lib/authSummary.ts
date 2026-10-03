import type { AuthStatus } from '@shared/auth'
import { assertNever } from '@shared/result'
import type { Tone } from './status'

export interface AuthSummary {
  /** Full headline for the auth view. */
  label: string
  /** Compact text for the top bar. */
  short: string
  tone: Tone
}

export function summarizeAuth(status: AuthStatus): AuthSummary {
  switch (status.state) {
    case 'authenticated':
      switch (status.mode) {
        case 'subscription':
          return {
            label: status.subscriptionType
              ? `Claude available: ${status.subscriptionType} subscription`
              : 'Claude available: subscription',
            short: 'Claude · subscription',
            tone: 'success',
          }
        case 'api_key':
          return { label: 'Authenticated with an API key', short: 'Claude · API key', tone: 'warning' }
        case 'third_party':
          return { label: 'Authenticated through a third-party provider', short: 'Claude · third-party', tone: 'active' }
        case 'unknown':
          return { label: 'Claude available (authentication mode not reported)', short: 'Claude', tone: 'success' }
        default:
          return assertNever(status.mode, 'auth mode')
      }
    case 'authentication_required':
      return { label: 'Authentication required', short: 'Sign in required', tone: 'danger' }
    case 'runtime_unavailable':
      return { label: 'Claude runtime unavailable', short: 'Runtime unavailable', tone: 'danger' }
    case 'sdk_error':
      return { label: 'Claude SDK error', short: 'SDK error', tone: 'danger' }
    case 'unknown':
      return { label: 'Authentication status unknown', short: 'Auth unknown', tone: 'neutral' }
    default:
      return assertNever(status.state, 'auth state')
  }
}
