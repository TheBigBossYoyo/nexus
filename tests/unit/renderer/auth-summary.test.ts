import { describe, expect, it } from 'vitest'
import type { AuthStatus } from '@shared/auth'
import { summarizeAuth } from '../../../src/renderer/src/lib/authSummary'

const status = (over: Partial<AuthStatus>): AuthStatus => ({
  state: 'authenticated',
  mode: 'subscription',
  subscriptionType: null,
  apiProvider: null,
  apiKeySource: null,
  email: null,
  organization: null,
  apiKeyEnvDetected: false,
  apiKeyEnvStripped: false,
  claudeCodeVersion: null,
  warnings: [],
  error: null,
  checkedAt: '2026-10-03T00:00:00Z',
  ...over,
})

describe('summarizeAuth', () => {
  it('distinguishes subscription from API-key authentication', () => {
    expect(summarizeAuth(status({ subscriptionType: 'max' }))).toMatchObject({
      tone: 'success',
      label: expect.stringContaining('max'),
    })
    expect(summarizeAuth(status({ mode: 'api_key' })).tone).toBe('warning')
    expect(summarizeAuth(status({ mode: 'third_party' })).tone).toBe('active')
  })

  it('flags the failure states as danger', () => {
    for (const state of ['authentication_required', 'runtime_unavailable', 'sdk_error'] as const) {
      expect(summarizeAuth(status({ state })).tone).toBe('danger')
    }
    expect(summarizeAuth(status({ state: 'unknown' })).tone).toBe('neutral')
  })
})
