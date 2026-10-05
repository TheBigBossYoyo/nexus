// Manual check against the REAL Claude runtime. It sends no prompt and starts no model turn: it asks the
// runtime for its account information and its (experimental) usage report, the two calls NEXUS uses to
// learn availability without spending usage. Run with `pnpm smoke:usage`. Writes evidence to docs/acceptance.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeSdkRuntime } from '@main/modules/agent-runtime/claude-sdk-runtime'
import { resolveClaudeExecutable } from '@main/modules/agent-runtime/resolve-executable'
import { classifyUsageSignal } from '@main/modules/usage'

const runtime = new ClaudeSdkRuntime({ resolveExecutable: () => resolveClaudeExecutable() })
afterAll(() => runtime.shutdown())

describe('real Claude runtime: account and usage report (no prompt)', () => {
  it('reports the account mode and, when the runtime supports it, the plan windows', async () => {
    const startedAt = new Date().toISOString()
    const auth = await runtime.getAccountInfo({ subscriptionMode: true })
    const started = Date.now()
    const report = await runtime.getUsageReport({ subscriptionMode: true })
    const reportMs = Date.now() - started

    const evidence = {
      kind: 'usage-report-smoke',
      startedAt,
      promptSent: false,
      // No identity is recorded: only what kind of account the runtime says it is.
      auth: { state: auth.state, mode: auth.mode, subscriptionType: auth.subscriptionType ?? null },
      usageReport:
        report === null
          ? { supported: false, note: 'The runtime did not answer the usage report (method missing, error or timeout).' }
          : {
              supported: true,
              durationMs: reportMs,
              rateLimitsAvailable: report.rateLimitsAvailable,
              subscriptionType: report.subscriptionType,
              windows: report.windows,
            },
      classified: report ? classifyUsageSignal({ kind: 'usage_report', report }, Date.now()) : null,
    }
    const dir = resolve(import.meta.dirname, '../../docs/acceptance')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `usage-report-${startedAt.replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`evidence: ${file}\n${JSON.stringify(evidence, null, 2)}`)

    expect(['authenticated', 'auth_required', 'runtime_unavailable', 'sdk_error']).toContain(auth.state)
    if (report) {
      for (const window of report.windows) {
        // A percentage NEXUS may show must be one the runtime gave, inside the documented range.
        if (window.utilizationPercent !== null) {
          expect(window.utilizationPercent).toBeGreaterThanOrEqual(0)
          expect(window.utilizationPercent).toBeLessThanOrEqual(100)
        }
        if (window.resetsAt !== null) expect(Number.isNaN(Date.parse(window.resetsAt))).toBe(false)
      }
    }
  })
})
