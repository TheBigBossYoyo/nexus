import type { CapacityPool } from './capacity'

export interface ChatGPTStatus {
  state:
    | 'SIGNED_OUT'
    | 'CONNECTING'
    | 'SIGNED_IN_NO_PLAN_USAGE'
    | 'SIGNED_IN_PLAN_USAGE'
    | 'AUTH_REQUIRES_RECONNECT'
    | 'STORAGE_UNAVAILABLE'
  profiles: { id: string; label: string; connected: boolean }[]
  activeProfile: string | null
  model: string | null
  models: { slug: string; display_name: string }[]
  error: string | null
  includedOnlyConfirmed: boolean
  capacity?: CapacityPool | null
}
