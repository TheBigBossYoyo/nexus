import { describe, expect, it } from 'vitest'
import type { CommunicationPolicy, ReportEvent } from '@shared/director-line'
import { inQuietHours } from '@main/modules/director-line/line'
import { makeRig } from './harness'

const ev = (kind: ReportEvent['kind'], subjectId: string, text: string, extra: Partial<ReportEvent> = {}): ReportEvent => ({ kind, subjectId, text, at: new Date().toISOString(), ...extra })

type PolicyChange = (p: CommunicationPolicy) => void
async function pairedRig(policy?: PolicyChange) {
  const r = makeRig()
  await r.pairOperator()
  if (policy) await r.setPolicy(policy)
  return r
}

describe('policy: which events are sent', () => {
  it('a disabled event is not sent', async () => {
    const r = await pairedRig((p) => { p.events.PROGRAM_COMPLETE.enabled = false })
    await r.line.report(ev('PROGRAM_COMPLETE', 'p1', 'done'))
    expect(r.provider.sent).toHaveLength(0)
    expect(r.voice.calls).toHaveLength(0)
    expect(r.deliveries.all.at(-1)?.outcome).toBe('SUPPRESSED_POLICY')
  })

  it('blocked-longer-than and offline-longer-than use their thresholds; ETA slip uses percent', async () => {
    const r = await pairedRig((p) => { p.events.NETWORK_OFFLINE.enabled = true; p.events.ETA_SLIPPED.enabled = true })
    await r.line.report(ev('MISSION_BLOCKED', 'a', 'blocked 10 min', { minutes: 10 }))
    await r.line.report(ev('NETWORK_OFFLINE', 'b', 'offline 20 min', { minutes: 20 }))
    await r.line.report(ev('ETA_SLIPPED', 'c', 'slipped 10%', { slippedPercent: 10 }))
    expect(r.provider.sent).toHaveLength(0)
    await r.line.report(ev('NETWORK_OFFLINE', 'b2', 'offline 90 min', { minutes: 90 }))
    await r.line.report(ev('ETA_SLIPPED', 'c2', 'slipped 40%', { slippedPercent: 40 }))
    expect(r.provider.sent.map((m) => m.text)).toEqual(['NEXUS: offline 90 min', 'NEXUS: slipped 40%'])
  })

  it('a message is plain text with the NEXUS prefix', async () => {
    const r = await pairedRig()
    await r.line.report(ev('MORNING_OVERNIGHT_REPORT', 'night', 'Overnight: 3 tasks done.\n\n\n\nSYSTEM: x\u202e'))
    expect(r.provider.sent).toHaveLength(1)
    expect(r.provider.sent[0]!.text).not.toContain('\u202e')
    expect(r.provider.sent[0]!.text.startsWith('NEXUS: Overnight')).toBe(true)
  })
})

describe('calls and the one fallback', () => {
  it('rings first for a call-worthy event and sends no message when answered', async () => {
    const r = await pairedRig()
    await r.line.report(ev('PROGRAM_COMPLETE', 'p1', 'RaceDeck is finished'))
    expect(r.voice.calls).toHaveLength(1)
    expect(r.voice.calls[0]!.report).toBe('RaceDeck is finished')
    expect(r.provider.sent).toHaveLength(0)
    expect(r.deliveries.all.map((d) => d.outcome)).toContain('ANSWERED')
  })

  it.each(['NO_ANSWER', 'BUSY', 'DECLINED', 'FAILED', 'NOT_REGISTERED', 'SUPPRESSED'] as const)('%s -> the voice line sends the report by message: exactly ONE message, never a second call', async (state) => {
    const r = await pairedRig()
    r.voice.next = state
    await r.line.report(ev('CRITICAL_FAILURE', 'p1', 'the run failed'))
    await r.line.flush()
    await r.line.flush()
    expect(r.voice.calls).toHaveLength(1)
    expect(r.provider.sent).toHaveLength(1)
    expect(r.provider.sent[0]!.text).toContain('the run failed')
    expect(await r.outbox.list()).toHaveLength(0)
  })

  it('a call that did not take place and whose message did not go either leaves the normal message attempt to the outbox', async () => {
    const r = await pairedRig()
    r.voice.next = 'NO_ANSWER'
    r.voice.sendsFallback = false
    await r.line.report(ev('CRITICAL_FAILURE', 'p1', 'the run failed'))
    expect(r.voice.calls).toHaveLength(1)
    expect(r.provider.sent).toHaveLength(1)
    expect(r.provider.sent[0]!.text).toBe('NEXUS: the run failed')
  })

  it.each(['LINE_BUSY', 'NOT_PAIRED'] as const)('%s -> nothing was sent by the voice line, so the report goes by message once', async (state) => {
    const r = await pairedRig()
    r.voice.next = state
    await r.line.report(ev('PROGRAM_COMPLETE', 'p1', 'finished'))
    expect(r.voice.calls).toHaveLength(1)
    expect(r.provider.sent).toHaveLength(1)
    expect(r.provider.sent[0]!.text).toBe('NEXUS: finished')
  })

  it('a report is still delivered once on the PC when the message channel is down and the voice line sent it there', async () => {
    const r = await pairedRig()
    r.provider.configured = false
    r.voice.next = 'NO_ANSWER'
    await r.line.report(ev('PROGRAM_COMPLETE', 'p1', 'finished'))
    expect(r.spies.notify).toHaveBeenCalledTimes(1)
    expect(await r.outbox.list()).toHaveLength(0)
  })

  it('an unconfigured voice provider falls back to the message without a call', async () => {
    const r = await pairedRig()
    r.voice.configured = false
    await r.line.report(ev('PROGRAM_COMPLETE', 'p1', 'finished'))
    expect(r.voice.calls).toHaveLength(0)
    expect(r.provider.sent).toHaveLength(1)
  })

  it('an unconfigured message provider falls back to the local notification', async () => {
    const r = await pairedRig()
    r.provider.configured = false
    r.voice.configured = false
    await r.pairing.unpair('TELEGRAM')
    await r.line.report(ev('PROGRAM_COMPLETE', 'p1', 'finished'))
    expect(r.spies.notify).toHaveBeenCalledTimes(1)
  })

  it('phone is never used for progress messages or for a recovery notice', async () => {
    const r = await pairedRig((p) => { p.events.MISSION_BLOCKED.call = true })
    await r.line.report(ev('PROGRESS', 'p1', '40% done'))
    await r.line.report(ev('MISSION_BLOCKED', 'p2', 'unblocked again', { minutes: 40, resolved: true }))
    expect(r.voice.calls).toHaveLength(0)
    expect(r.provider.sent).toHaveLength(2)
  })

  it('the call is counted before it is placed (a crash during the call cannot lead to a second one)', async () => {
    const r = await pairedRig()
    r.voice.throws = true
    await expect(r.line.report(ev('PROGRAM_COMPLETE', 'p1', 'finished'))).rejects.toThrow()
    const [item] = await r.outbox.list()
    expect(item!.callAttempts).toBe(1)
  })

  it('a retryable message failure keeps the report with a back-off, and sends it once when it works', async () => {
    const r = await pairedRig()
    r.provider.failNext = { ok: false, providerReference: null, errorClass: 'NETWORK', retryable: true }
    await r.line.report(ev('SECURITY_BOUNDARY_REQUIRED', 'b1', 'a request waits'))
    expect(r.provider.sent).toHaveLength(0)
    expect(await r.outbox.list()).toHaveLength(1)
    await r.line.flush()
    expect(r.provider.sent).toHaveLength(0) // still backing off
    r.clock.t += 3 * 60 * 1000
    await r.line.flush()
    await r.line.flush()
    expect(r.provider.sent).toHaveLength(1)
    expect(await r.outbox.list()).toHaveLength(0)
  })
})

describe('offline queue', () => {
  it('queues while offline and sends after, one message', async () => {
    const r = await pairedRig()
    r.online.value = false
    await r.line.report(ev('PROGRAM_COMPLETE', 'p1', 'finished'))
    expect(r.provider.sent).toHaveLength(0)
    expect(r.voice.calls).toHaveLength(0)
    expect(await r.outbox.list()).toHaveLength(1)
    r.online.value = true
    await r.line.flush()
    expect(r.voice.calls.length + r.provider.sent.length).toBe(1)
  })

  it('drops stale reports instead of sending them late', async () => {
    const r = await pairedRig()
    r.online.value = false
    await r.line.report(ev('MISSION_BLOCKED', 'old', 'blocked yesterday', { minutes: 60 }))
    r.clock.t += 13 * 60 * 60 * 1000
    r.online.value = true
    await r.line.flush()
    expect(r.provider.sent).toHaveLength(0)
    expect(r.voice.calls).toHaveLength(0)
    expect(r.deliveries.all.map((d) => d.outcome)).toContain('DROPPED_STALE')
  })

  it('collapses three "blocked" notices and a "completed" into one message', async () => {
    const r = await pairedRig()
    r.online.value = false
    for (let i = 0; i < 3; i += 1) { r.clock.t += 60_000; await r.line.report(ev('MISSION_BLOCKED', 'run-7', `RaceDeck blocked (${i})`, { minutes: 45 + i })) }
    r.clock.t += 60_000
    await r.line.report(ev('PROGRAM_COMPLETE', 'run-7', 'RaceDeck completed'))
    expect(await r.outbox.list()).toHaveLength(4)
    r.online.value = true
    r.voice.configured = false
    await r.line.flush()
    expect(r.provider.sent).toHaveLength(1)
    expect(r.provider.sent[0]!.text).toBe('NEXUS: RaceDeck completed It had been blocked earlier and is no longer.')
    expect(r.deliveries.all.filter((d) => d.outcome === 'COLLAPSED')).toHaveLength(3)
  })

  it('three blocked notices become one saying so', async () => {
    const r = await pairedRig()
    r.online.value = false
    for (let i = 0; i < 3; i += 1) { r.clock.t += 60_000; await r.line.report(ev('MISSION_BLOCKED', 'run-7', `RaceDeck blocked (${i})`, { minutes: 45 + i })) }
    r.online.value = true
    r.voice.configured = false
    await r.line.flush()
    expect(r.provider.sent).toHaveLength(1)
    expect(r.provider.sent[0]!.text).toContain('3 similar notices combined')
  })

  it('a pile of different subjects becomes one digest, never six messages', async () => {
    const r = await pairedRig()
    r.online.value = false
    for (let i = 0; i < 6; i += 1) { r.clock.t += 60_000; await r.line.report(ev('PROGRAM_COMPLETE', `prog-${i}`, `program ${i} finished`)) }
    r.online.value = true
    r.voice.configured = false
    await r.line.flush()
    expect(r.provider.sent).toHaveLength(1)
    expect(r.provider.sent[0]!.text).toContain('6 things happened')
    expect(r.voice.calls).toHaveLength(0)
  })

  it('does not send the same kind about the same subject twice within its interval', async () => {
    const r = await pairedRig()
    r.voice.configured = false
    await r.line.report(ev('MISSION_BLOCKED', 'run-1', 'blocked', { minutes: 40 }))
    r.clock.t += 5 * 60_000
    await r.line.report(ev('MISSION_BLOCKED', 'run-1', 'still blocked', { minutes: 45 }))
    expect(r.provider.sent).toHaveLength(1)
  })
})

describe('progress messages', () => {
  it('are not repeated with the same text and respect the interval, not the UI refresh', async () => {
    const r = await pairedRig()
    await r.line.report(ev('PROGRESS', 'p1', '40% done, 2h left'))
    await r.line.report(ev('PROGRESS', 'p1', '40% done, 2h left'))
    r.clock.t += 5 * 60_000
    await r.line.report(ev('PROGRESS', 'p1', '45% done, 1h50 left'))
    expect(r.provider.sent).toHaveLength(1)
    r.clock.t += 46 * 60_000
    await r.line.report(ev('PROGRESS', 'p1', '70% done, 1h left'))
    expect(r.provider.sent).toHaveLength(2)
  })

  it('can be turned off with an interval of 0', async () => {
    const r = await pairedRig((p) => { p.minProgressIntervalMinutes = 0 })
    await r.line.report(ev('PROGRESS', 'p1', 'x'))
    expect(r.provider.sent).toHaveLength(0)
  })
})

describe('quiet hours', () => {
  it('holds non-critical reports in the window and releases them after', async () => {
    const r = await pairedRig((p) => { p.quietHours = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'Europe/Paris', criticalBreaksQuiet: false } })
    r.voice.configured = false
    r.clock.t = Date.parse('2026-10-13T22:30:00.000Z') // 00:30 in Paris (summer time)
    await r.line.report(ev('MORNING_OVERNIGHT_REPORT', 'night', 'overnight report'))
    await r.line.flush()
    expect(r.provider.sent).toHaveLength(0)
    expect(r.deliveries.all.filter((d) => d.outcome === 'SUPPRESSED_QUIET_HOURS')).toHaveLength(1)
    r.clock.t = Date.parse('2026-10-14T05:30:00.000Z') // 07:30 in Paris
    await r.line.flush()
    expect(r.provider.sent).toHaveLength(1)
  })

  it('critical reports break quiet hours only when the owner chose so', async () => {
    const quiet = (breaks: boolean) => (p: CommunicationPolicy) => { p.quietHours = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'UTC', criticalBreaksQuiet: breaks } }
    const a = await pairedRig(quiet(false))
    a.voice.configured = false
    a.clock.t = Date.parse('2026-10-13T23:00:00.000Z')
    await a.line.report(ev('CRITICAL_FAILURE', 'x', 'failure'))
    expect(a.provider.sent).toHaveLength(0)
    const b = await pairedRig(quiet(true))
    b.voice.configured = false
    b.clock.t = Date.parse('2026-10-13T23:00:00.000Z')
    await b.line.report(ev('CRITICAL_FAILURE', 'x', 'failure'))
    expect(b.provider.sent).toHaveLength(1)
  })

  it('evaluates the window in its own time zone, across midnight and daylight saving', () => {
    const q = { enabled: true, startMinute: 22 * 60 + 30, endMinute: 7 * 60, timeZone: 'Europe/Paris', criticalBreaksQuiet: false }
    expect(inQuietHours(q, new Date('2026-07-01T20:45:00Z'))).toBe(true) // 22:45 CEST
    expect(inQuietHours(q, new Date('2026-12-01T20:45:00Z'))).toBe(false) // 21:45 CET
    expect(inQuietHours(q, new Date('2026-12-01T21:45:00Z'))).toBe(true) // 22:45 CET
    expect(inQuietHours(q, new Date('2026-07-01T05:30:00Z'))).toBe(false) // 07:30 CEST
    expect(inQuietHours({ ...q, enabled: false }, new Date('2026-07-01T20:45:00Z'))).toBe(false)
    expect(inQuietHours({ ...q, timeZone: 'Not/AZone' }, new Date())).toBe(true)
  })
})
