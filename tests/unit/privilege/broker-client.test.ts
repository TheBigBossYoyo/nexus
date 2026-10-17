import { describe, expect, it, vi } from 'vitest'
import { ElevatedBrokerClient } from '../../../src/main/modules/privilege/broker-client'
import type { LongProcess } from '../../../src/main/modules/process/spawn-process'

function fakeProcess(): { proc: LongProcess; exit: (code: number | null) => void; stop: ReturnType<typeof vi.fn> } {
  let exit!: (code: number | null) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    exit = (code) => resolve({ code, signal: null })
  })
  const stop = vi.fn(async () => undefined)
  const proc: LongProcess = { pid: 1, writeInput: () => true, endInput: () => undefined, output: () => [], exitCode: () => null, exited, stop }
  return { proc, exit, stop }
}

const options = (fake: ReturnType<typeof fakeProcess>, consentTimeoutMs: number) => ({
  helperPath: 'nexus-elevate.exe',
  runtimePid: 1,
  session: 's1',
  expiresAt: new Date(Date.now() + 60_000),
  capabilities: [] as never[],
  cwd: '.',
  consentTimeoutMs,
  spawn: () => fake.proc,
})

describe('ElevatedBrokerClient.start failures', () => {
  it('a consent timeout fails, says a late UAC acceptance exits with code 9, and stops the relay', async () => {
    const fake = fakeProcess()
    const r = await ElevatedBrokerClient.start(options(fake, 10))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.outcome).toBe('FAILED')
    expect(r.reason).toContain('code 9')
    expect(r.reason).toContain('after')
    expect(r.reason).toContain('prepare the session again')
    expect(r.reason.length).toBeLessThanOrEqual(400)
    expect(fake.stop).toHaveBeenCalled()
  })

  it('a relay exit with code 5 before the timeout is DECLINED', async () => {
    const fake = fakeProcess()
    const p = ElevatedBrokerClient.start(options(fake, 5000))
    fake.exit(5)
    expect(await p).toEqual({ ok: false, outcome: 'DECLINED', reason: 'The administrator prompt was declined.' })
  })

  it('a relay exit with code 9 before the timeout keeps the relay-ended reason', async () => {
    const fake = fakeProcess()
    const p = ElevatedBrokerClient.start(options(fake, 5000))
    fake.exit(9)
    expect(await p).toEqual({ ok: false, outcome: 'FAILED', reason: "The broker's relay ended (code 9)." })
  })
})

// Manual check only: needs a real UAC prompt answered after the timeout. It never starts nexus-elevate.exe itself.
describe.skipIf(process.env.NEXUS_REAL_UAC_TEST !== '1')('real UAC prompt accepted late (manual, NEXUS_REAL_UAC_TEST=1)', () => {
  it.skip('prepare a session with a tiny consent timeout, accept the UAC prompt late, read the reason', () => undefined)
})
