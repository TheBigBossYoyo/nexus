export type AuthState =
  | 'authenticated'
  | 'authentication_required'
  | 'runtime_unavailable'
  | 'sdk_error'
  | 'unknown'

/** What the Claude runtime reports about the active credentials. NEXUS never reads tokens itself. */
export interface AuthStatus {
  state: AuthState
  /** 'subscription' when the runtime reports an OAuth/claude.ai login, 'api_key' for key-based auth. */
  mode: 'subscription' | 'api_key' | 'third_party' | 'unknown'
  subscriptionType: string | null
  apiProvider: string | null
  apiKeySource: string | null
  /** Shown only in the UI; never logged. */
  email: string | null
  organization: string | null
  /** True when ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) exists in the NEXUS process environment. */
  apiKeyEnvDetected: boolean
  /** True when Subscription Mode is on, so the key is stripped from agent environments. */
  apiKeyEnvStripped: boolean
  claudeCodeVersion: string | null
  warnings: string[]
  error: string | null
  checkedAt: string
}

export interface ModelOption {
  value: string
  displayName: string
  description: string
  supportsEffort: boolean
}

export const API_KEY_WARNING =
  'ANTHROPIC_API_KEY is present and may cause Claude usage to be billed through the API rather than your Claude subscription.'
