import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LinphoneSipProvider,
  type HelperHandlers,
  type HelperProcess,
  type LinphoneSipProviderOptions,
  type SipAccount,
} from '@main/modules/director-line/linphone-sip-provider'
import type { CallEndReason, PlacedCall, VoiceCall, VoiceProviderState } from '@main/modules/director-line/voice-provider'

// 0.9.1: the NEXUS side of the SIP helper, against a helper that is a script. No process, no network.
const PASSWORD = 'correct-horse-battery-staple-7731'

const ACCOUNT: SipAccount = {
  identity: 'sip:nexus-director@sip.example.test',
  password: PASSWORD,
  displayName: 'NEXUS Director',
  server: 'sip:sip.example.test;transport=tls',
  transport: 'tls',
  mediaEncryption: 'zrtp',
  mediaEncryptionMandatory: true,
  stunServer: 'stun.example.test',
  ice: false,
}

class FakeHelper implements HelperProcess {
  written: string[] = []
  closed = false
  killed = false
  private done!: () => void
  readonly exited = new Promise<unknown>((resolve) => (this.done = () => resolve({ code: 0 })))
  constructor(readonly handlers: HelperHandlers) {}
  write(line: string): boolean {
    if (this.closed) return false
    this.written.push(line)
    return true
  }
  end(): void {
    this.closed = true
  }
  async stop(): Promise<void> {
    this.killed = true
    this.done()
  }
  exit(): void {
    this.done()
  }
  emit(event: Record<string, unknown>): void {
    this.handlers.stdout(JSON.stringify(event))
  }
  /** The commands written so far, parsed. */
  commands(): Record<string, unknown>[] {
    return this.written.map((l) => JSON.parse(l) as Record<string, unknown>)
  }
  sent(name: string): Record<string, unknown>[] {
    return this.commands().filter((c) => c.c === name)
  }
}

function rig(options: Partial<Omit<LinphoneSipProviderOptions, 'account'>> & { account?: SipAccount | null; autoReady?: boolean } = {}) {
  const { account: accountOption, ...over } = options
  const helpers: FakeHelper[] = []
  const logs: string[] = []
  const states: [VoiceProviderState, string | undefined][] = []
  const incoming: VoiceCall[] = []
  const accountCalls = { n: 0 }
  const account = accountOption === undefined ? ACCOUNT : accountOption
  const provider = new LinphoneSipProvider({
    helperPath: 'C:/nexus/nexus-sip.exe',
    runtimeDir: 'C:/nexus/linphone',
    stateDir: 'C:/nexus/state',
    account: async () => {
      accountCalls.n++
      return account
    },
    spawn: (_file, _args, handlers) => {
      const h = new FakeHelper(handlers)
      helpers.push(h)
      if (over.autoReady !== false) queueMicrotask(() => h.emit({ e: 'ready', version: '5.5.32' }))
      return h
    },
    log: (m) => void logs.push(m),
    restartDelayMs: () => 5,
    quitGraceMs: 30,
    ...over,
  })
  const started = provider.start({ incoming: (c) => void incoming.push(c), state: (s, d) => void states.push([s, d]) })
  const helper = (): FakeHelper => helpers[helpers.length - 1] as FakeHelper
  const register = async (): Promise<void> => {
    await started
    helper().emit({ e: 'registration', state: 'ok' })
  }
  return { provider, helpers, helper, logs, states, incoming, accountCalls, started, register }
}

async function ready(r: ReturnType<typeof rig>): Promise<FakeHelper> {
  await r.started
  await vi.waitFor(() => expect(r.helper().sent('configure')).toHaveLength(1))
  r.helper().emit({ e: 'registration', state: 'ok' })
  expect(r.provider.state()).toBe('REGISTERED')
  return r.helper()
}

async function incomingCall(r: ReturnType<typeof rig>, h: FakeHelper, from = 'sip:user@sip.example.test', extra: Record<string, unknown> = {}): Promise<VoiceCall> {
  const before = r.incoming.length
  h.emit({ e: 'incoming', call: 'c1', from, fromDisplayName: 'user', viaRegisteredAccount: true, ...extra })
  await vi.waitFor(() => expect(r.incoming.length).toBe(before + 1))
  return r.incoming[before] as VoiceCall
}

const provs: LinphoneSipProvider[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const p of provs.splice(0)) await p.stop().catch(() => undefined)
})

function track<T extends ReturnType<typeof rig>>(r: T): T {
  provs.push(r.provider)
  return r
}

describe('configuring the helper', () => {
  it('sends the account in one configure line, and the password nowhere else', async () => {
    const r = track(rig())
    const h = await ready(r)
    const configure = h.sent('configure')[0] as Record<string, unknown>
    expect(configure).toMatchObject({
      c: 'configure',
      identity: ACCOUNT.identity,
      password: PASSWORD,
      displayName: 'NEXUS Director',
      server: ACCOUNT.server,
      transport: 'tls',
      mediaEncryption: 'zrtp',
      mediaEncryptionMandatory: true,
      stunServer: 'stun.example.test',
      ice: false,
      register: true,
      sipPort: -1,
    })
    // everything that happens next: an error from the helper, garbage, stderr, a call, a refusal, a crash
    h.handlers.stderr('nexus-sip: something odd')
    h.emit({ e: 'error', message: 'configure: "identity" is required' })
    h.handlers.stdout('this is not json')
    h.emit({ e: 'registration', state: 'failed', reason: '403 Forbidden' })
    const call = await incomingCall(r, h)
    await call.hangUp().catch((e: unknown) => r.logs.push(String(e)))
    h.exit()
    await vi.waitFor(() => expect(r.helpers.length).toBe(2))
    const inEveryLine = h.written.filter((l) => l.includes(PASSWORD))
    expect(inEveryLine).toHaveLength(1)
    expect(h.written[0]).toContain(PASSWORD)
    // the new helper gets the password again, in its own configure line only
    await vi.waitFor(() => expect(r.helper().sent('configure')).toHaveLength(1))
    expect(r.helper().written.filter((l) => l.includes(PASSWORD))).toHaveLength(1)
    expect(JSON.stringify(r.logs)).not.toContain(PASSWORD)
    expect(JSON.stringify(r.states)).not.toContain(PASSWORD)
    expect(JSON.stringify(r.provider.diagnostics())).not.toContain(PASSWORD)
  })

  it('names the helper with the runtime and the state folder and nothing else', async () => {
    const seen: string[][] = []
    const r = track(rig({ spawn: (file, args, handlers) => {
      seen.push([file, ...args])
      const h = new FakeHelper(handlers)
      queueMicrotask(() => h.emit({ e: 'ready' }))
      return h
    } }))
    await r.started
    expect(seen[0]).toEqual(['C:/nexus/nexus-sip.exe', '--runtime', 'C:/nexus/linphone', '--state', 'C:/nexus/state'])
  })

  it('does not start a helper when there is no account', async () => {
    const r = track(rig({ account: null }))
    await r.started
    expect(r.helpers).toHaveLength(0)
    expect(r.provider.state()).toBe('STOPPED')
  })

  it('does not put the password in a failure to start the helper', async () => {
    const r = track(rig({ spawn: () => { throw new Error('spawn EPERM') } }))
    await r.started
    expect(r.provider.state()).toBe('UNREACHABLE')
    expect(JSON.stringify(r.logs)).not.toContain(PASSWORD)
  })

  it('without registration it only listens, and says so', async () => {
    const r = track(rig({ register: false, sipPort: 5555, account: { ...ACCOUNT, password: '' } }))
    await r.started
    await vi.waitFor(() => expect(r.helper().sent('configure')).toHaveLength(1))
    const c = r.helper().sent('configure')[0] as Record<string, unknown>
    expect(c).toMatchObject({ register: false, sipPort: 5555 })
    expect('password' in c).toBe(false)
    expect(r.provider.state()).toBe('REGISTERED')
  })
})

describe('registration', () => {
  it('maps the helper registration states to the provider states', async () => {
    const r = track(rig())
    const h = await ready(r)
    h.emit({ e: 'registration', state: 'progress' })
    expect(r.provider.state()).toBe('CONNECTING')
    h.emit({ e: 'registration', state: 'ok' })
    expect(r.provider.state()).toBe('REGISTERED')
    h.emit({ e: 'registration', state: 'failed', reason: '403 Forbidden' })
    expect(r.provider.state()).toBe('REJECTED')
    h.emit({ e: 'registration', state: 'failed', reason: '401 Unauthorized' })
    expect(r.provider.state()).toBe('REJECTED')
    h.emit({ e: 'registration', state: 'failed', reason: 'Request timeout' })
    expect(r.provider.state()).toBe('UNREACHABLE')
    h.emit({ e: 'registration', state: 'cleared' })
    expect(r.provider.state()).toBe('CONNECTING')
    expect(r.states.map((s) => s[0])).toEqual(['CONNECTING', 'REGISTERED', 'CONNECTING', 'REGISTERED', 'REJECTED', 'REJECTED', 'UNREACHABLE', 'CONNECTING'])
  })

  it('asks the helper to refresh when the network changed', async () => {
    const r = track(rig())
    const h = await ready(r)
    r.provider.networkChanged()
    expect(h.sent('refresh')).toHaveLength(1)
  })
})

describe('an incoming call', () => {
  it('is TRANSPORT_AUTHENTICATED only through the registered account with a From of its own domain', async () => {
    const r = track(rig())
    const h = await ready(r)
    const call = await incomingCall(r, h, '"user" <sip:user@SIP.EXAMPLE.TEST;transport=tls>')
    expect(call.direction).toBe('INBOUND')
    expect(call.remoteIdentity).toBe('sip:user@sip.example.test')
    expect(call.identityAssurance).toBe('TRANSPORT_AUTHENTICATED')
    expect(call.format).toEqual({ sampleRate: 16000 })
    expect(h.sent('answer')).toHaveLength(0)
  })

  it('is only CLAIMED from another domain, or when it did not come through the account', async () => {
    const r = track(rig())
    const h = await ready(r)
    const other = await incomingCall(r, h, 'sip:user@elsewhere.example.test')
    expect(other.identityAssurance).toBe('CLAIMED')
    h.emit({ e: 'call', call: 'c1', state: 'ended', reason: 'remote' })
    const direct = await incomingCall(r, h, 'sip:user@sip.example.test', { call: 'c2', viaRegisteredAccount: false })
    expect(direct.identityAssurance).toBe('CLAIMED')
  })

  it('is only CLAIMED when the account is not registered at that moment', async () => {
    const r = track(rig())
    const h = await ready(r)
    h.emit({ e: 'registration', state: 'failed', reason: 'timeout' })
    const call = await incomingCall(r, h)
    expect(call.identityAssurance).toBe('CLAIMED')
  })

  it('is declined by the provider when the From is not a SIP identity, and never reaches the voice line', async () => {
    const r = track(rig())
    const h = await ready(r)
    h.emit({ e: 'incoming', call: 'c9', from: 'sip:127.0.0.1:5060', viaRegisteredAccount: false })
    h.emit({ e: 'incoming', call: 'c10', from: 'anonymous', viaRegisteredAccount: true })
    await vi.waitFor(() => expect(h.sent('decline')).toHaveLength(2))
    expect(r.incoming).toHaveLength(0)
    expect(h.sent('decline').map((c) => c.call)).toEqual(['c9', 'c10'])
  })

  it('answers when asked, and resolves when the sound is running', async () => {
    const r = track(rig())
    const h = await ready(r)
    const call = await incomingCall(r, h)
    const answered = call.answer()
    expect(h.sent('answer')).toEqual([{ c: 'answer', call: 'c1' }])
    h.emit({ e: 'call', call: 'c1', state: 'connected' })
    h.emit({ e: 'call', call: 'c1', state: 'streams' })
    await expect(answered).resolves.toBeUndefined()
  })

  it('rejects the answer of a call that ended first', async () => {
    const r = track(rig())
    const h = await ready(r)
    const call = await incomingCall(r, h)
    const answered = call.answer()
    h.emit({ e: 'call', call: 'c1', state: 'ended', reason: 'remote' })
    await expect(answered).rejects.toThrow(/ended/)
  })

  it('hangs up, and reports how it ended once', async () => {
    const r = track(rig())
    const h = await ready(r)
    const call = await incomingCall(r, h)
    const ends: CallEndReason[] = []
    call.onEnded((reason) => void ends.push(reason))
    h.emit({ e: 'call', call: 'c1', state: 'streams' })
    const hung = call.hangUp()
    expect(h.sent('hangup')).toEqual([{ c: 'hangup', call: 'c1' }])
    h.emit({ e: 'call', call: 'c1', state: 'ended', reason: 'local' })
    await hung
    h.emit({ e: 'call', call: 'c1', state: 'ended', reason: 'local' })
    expect(ends).toEqual(['LOCAL_HUNG_UP'])
    // a late listener still hears it
    const late: CallEndReason[] = []
    call.onEnded((reason) => void late.push(reason))
    expect(late).toEqual(['LOCAL_HUNG_UP'])
  })

  it('reports a remote hang-up and a network loss', async () => {
    const r = track(rig())
    const h = await ready(r)
    const a = await incomingCall(r, h)
    const reasons: CallEndReason[] = []
    a.onEnded((x) => void reasons.push(x))
    h.emit({ e: 'call', call: 'c1', state: 'ended', reason: 'remote' })
    const b = await incomingCall(r, h, 'sip:user@sip.example.test', { call: 'c2' })
    b.onEnded((x) => void reasons.push(x))
    h.emit({ e: 'call', call: 'c2', state: 'error', reason: 'network' })
    expect(reasons).toEqual(['REMOTE_HUNG_UP', 'NETWORK_LOST'])
  })

  it('declines a second call while one is in progress', async () => {
    const r = track(rig())
    const h = await ready(r)
    await incomingCall(r, h)
    h.emit({ e: 'incoming', call: 'c2', from: 'sip:other@sip.example.test', viaRegisteredAccount: true })
    await vi.waitFor(() => expect(h.sent('decline')).toEqual([{ c: 'decline', call: 'c2' }]))
    expect(r.incoming).toHaveLength(1)
  })

  it('gives received sound and key presses to the listeners', async () => {
    const r = track(rig())
    const h = await ready(r)
    const call = await incomingCall(r, h)
    const heard: Buffer[] = []
    const keys: string[] = []
    call.onAudio((pcm) => void heard.push(pcm))
    call.onDigit((d) => void keys.push(d))
    h.emit({ e: 'audio', call: 'c1', pcm: Buffer.alloc(640, 7).toString('base64') })
    h.emit({ e: 'audio', call: 'other', pcm: Buffer.alloc(640, 9).toString('base64') })
    h.emit({ e: 'dtmf', call: 'c1', digit: '5' })
    h.emit({ e: 'dtmf', call: 'c1', digit: 'x' })
    expect(heard).toHaveLength(1)
    expect(heard[0]?.length).toBe(640)
    expect(keys).toEqual(['5'])
  })
})

describe('sound to the other party', () => {
  async function started(): Promise<{ h: FakeHelper; call: VoiceCall }> {
    const r = track(rig())
    const h = await ready(r)
    const call = await incomingCall(r, h)
    h.emit({ e: 'call', call: 'c1', state: 'streams' })
    return { h, call }
  }
  const audioBytes = (h: FakeHelper): number[] => h.sent('audio').map((c) => Buffer.from(c.pcm as string, 'base64').length)

  it('cuts any length into 20 ms frames and keeps the rest for the next piece', async () => {
    const { h, call } = await started()
    call.sendAudio(Buffer.alloc(1000, 1))
    expect(audioBytes(h)).toEqual([640])
    call.sendAudio(Buffer.alloc(300, 2))
    expect(audioBytes(h)).toEqual([640, 640])
    call.sendAudio(Buffer.alloc(2000, 3))
    expect(audioBytes(h)).toEqual([640, 640, 640, 640, 640])
    expect(h.sent('audio').every((c) => c.call === 'c1')).toBe(true)
    // the order of the bytes is kept
    const joined = Buffer.concat(h.sent('audio').map((c) => Buffer.from(c.pcm as string, 'base64')))
    expect(joined[0]).toBe(1)
    expect(joined[999]).toBe(1)
    expect(joined[1000]).toBe(2)
    expect(joined[1299]).toBe(2)
    expect(joined[1300]).toBe(3)
  })

  it('clears: sends clear and forgets what was waiting for a whole frame', async () => {
    const { h, call } = await started()
    call.sendAudio(Buffer.alloc(100, 5))
    call.clearAudio()
    expect(h.sent('clear')).toEqual([{ c: 'clear', call: 'c1' }])
    call.sendAudio(Buffer.alloc(640, 6))
    const frames = h.sent('audio')
    expect(frames).toHaveLength(1)
    expect(Buffer.from(frames[0]?.pcm as string, 'base64')[0]).toBe(6)
  })

  it('is drained when the helper says playback reached the mark, after the last piece is played out', async () => {
    const { h, call } = await started()
    call.sendAudio(Buffer.alloc(700, 4))
    let done = false
    const drained = call.drained().then(() => void (done = true))
    expect(audioBytes(h)).toEqual([640, 640])
    const mark = h.sent('mark')[0] as { call: string; name: string }
    expect(mark.call).toBe('c1')
    await Promise.resolve()
    expect(done).toBe(false)
    h.emit({ e: 'played', call: 'c1', name: 'someone-else' })
    await Promise.resolve()
    expect(done).toBe(false)
    h.emit({ e: 'played', call: 'c1', name: mark.name })
    await drained
    expect(done).toBe(true)
  })

  it('is drained when the call ends, so that nothing waits for sound that will not come', async () => {
    const { h, call } = await started()
    const drained = call.drained()
    h.emit({ e: 'call', call: 'c1', state: 'ended', reason: 'remote' })
    await expect(drained).resolves.toBeUndefined()
    await expect(call.drained()).resolves.toBeUndefined()
  })

  it('plays nothing into a call that has ended', async () => {
    const { h, call } = await started()
    h.emit({ e: 'call', call: 'c1', state: 'ended', reason: 'remote' })
    const before = h.written.length
    call.sendAudio(Buffer.alloc(640))
    call.clearAudio()
    expect(h.written.length).toBe(before)
  })
})

describe('what was negotiated', () => {
  it('is unknown until the helper says, and never assumed from what was asked for', async () => {
    const r = track(rig())
    const h = await ready(r)
    const call = await incomingCall(r, h)
    expect(call.security()).toEqual({ signalling: 'TLS', media: 'UNKNOWN', endToEnd: false })
    h.emit({ e: 'media', call: 'c1', codec: 'opus', clockRate: 48000, encryption: 'none', zrtpSas: null, srtpSuite: null })
    expect(call.security()).toEqual({ signalling: 'TLS', media: 'NONE', endToEnd: false })
    h.emit({ e: 'media', call: 'c1', codec: 'opus', clockRate: 48000, encryption: 'srtp', zrtpSas: null, srtpSuite: 'AES_CM_128_HMAC_SHA1_80' })
    expect(call.security()).toEqual({ signalling: 'TLS', media: 'SRTP', endToEnd: false })
    h.emit({ e: 'media', call: 'c1', codec: 'opus', clockRate: 48000, encryption: 'zrtp', zrtpSas: 'ABCD', srtpSuite: 'AEAD_AES_128_GCM' })
    expect(call.security()).toEqual({ signalling: 'TLS', media: 'ZRTP', endToEnd: true })
    h.emit({ e: 'media', call: 'c1', codec: 'opus', clockRate: 48000, encryption: 'dtls', zrtpSas: null, srtpSuite: 'AEAD_AES_128_GCM' })
    expect(call.security()).toEqual({ signalling: 'TLS', media: 'DTLS_SRTP', endToEnd: true })
  })

  it('says TLS only when the transport is tls and the account is registered', async () => {
    const r = track(rig())
    const h = await ready(r)
    const call = await incomingCall(r, h)
    h.emit({ e: 'registration', state: 'failed', reason: 'timeout' })
    expect(call.security().signalling).toBe('UNKNOWN')
    const udp = track(rig({ account: { ...ACCOUNT, transport: 'udp' } }))
    const hu = await ready(udp)
    const c = await incomingCall(udp, hu)
    expect(c.security().signalling).toBe('NONE')
  })
})

describe('placing a call', () => {
  const place = (r: ReturnType<typeof rig>, ringSeconds = 20): Promise<PlacedCall> => r.provider.placeCall('sip:user@sip.example.test', { ringSeconds })

  it('resolves ANSWERED with the call once the sound is running', async () => {
    const r = track(rig())
    const h = await ready(r)
    const placed = place(r)
    await vi.waitFor(() => expect(h.sent('call')).toEqual([{ c: 'call', to: 'sip:user@sip.example.test' }]))
    h.emit({ e: 'call', call: 'c1', state: 'outgoing' })
    h.emit({ e: 'call', call: 'c1', state: 'ringing' })
    h.emit({ e: 'call', call: 'c1', state: 'connected' })
    h.emit({ e: 'call', call: 'c1', state: 'streams' })
    const result = await placed
    expect(result.outcome).toBe('ANSWERED')
    if (result.outcome !== 'ANSWERED') return
    expect(result.call.direction).toBe('OUTBOUND')
    expect(result.call.remoteIdentity).toBe('sip:user@sip.example.test')
    expect(result.call.identityAssurance).toBe('TRANSPORT_AUTHENTICATED')
  })

  it.each([
    ['busy', 'BUSY'],
    ['declined', 'DECLINED'],
    ['no_answer', 'NO_ANSWER'],
    ['not_found', 'FAILED'],
  ])('maps the end reason %s to %s', async (reason, outcome) => {
    const r = track(rig())
    const h = await ready(r)
    const placed = place(r)
    await vi.waitFor(() => expect(h.sent('call')).toHaveLength(1))
    h.emit({ e: 'call', call: 'c1', state: 'outgoing' })
    h.emit({ e: 'call', call: 'c1', state: 'error', reason })
    expect((await placed).outcome).toBe(outcome)
    // and the line is free again
    const again = place(r)
    await vi.waitFor(() => expect(h.sent('call')).toHaveLength(2))
    h.emit({ e: 'call', call: 'c2', state: 'outgoing' })
    h.emit({ e: 'call', call: 'c2', state: 'streams' })
    expect((await again).outcome).toBe('ANSWERED')
  })

  it('gives up after the ring time, hangs up, and says NO_ANSWER', async () => {
    vi.useFakeTimers()
    const r = track(rig())
    const h = await ready(r)
    const placed = place(r, 15)
    await vi.advanceTimersByTimeAsync(10)
    h.emit({ e: 'call', call: 'c1', state: 'outgoing' })
    h.emit({ e: 'call', call: 'c1', state: 'ringing' })
    await vi.advanceTimersByTimeAsync(14_000)
    expect(h.sent('hangup')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.sent('hangup')).toEqual([{ c: 'hangup', call: 'c1' }])
    h.emit({ e: 'call', call: 'c1', state: 'ended', reason: 'local' })
    expect(await placed).toEqual({ outcome: 'NO_ANSWER' })
  })

  it('says NO_ANSWER even when the helper never names the call', async () => {
    vi.useFakeTimers()
    const r = track(rig())
    await ready(r)
    const placed = place(r, 5)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2100)
    expect(await placed).toEqual({ outcome: 'NO_ANSWER' })
  })

  it('fails at once when the line is not connected, or the address is not SIP', async () => {
    const r = track(rig())
    await r.started
    expect((await place(r)).outcome).toBe('FAILED')
    r.helper().emit({ e: 'registration', state: 'ok' })
    expect((await r.provider.placeCall('not an address', { ringSeconds: 5 })).outcome).toBe('FAILED')
    expect(r.helper().sent('call')).toHaveLength(0)
  })

  it('fails when the helper cannot start the call, and when the helper dies meanwhile', async () => {
    const r = track(rig())
    const h = await ready(r)
    const a = place(r)
    await vi.waitFor(() => expect(h.sent('call')).toHaveLength(1))
    h.emit({ e: 'call', call: 'none', state: 'error', reason: 'invalid' })
    expect((await a).outcome).toBe('FAILED')
    const b = place(r)
    await vi.waitFor(() => expect(h.sent('call')).toHaveLength(2))
    h.exit()
    expect((await b).outcome).toBe('FAILED')
  })

  it('refuses a second call while one is being placed', async () => {
    const r = track(rig())
    const h = await ready(r)
    void place(r)
    await vi.waitFor(() => expect(h.sent('call')).toHaveLength(1))
    expect((await place(r)).outcome).toBe('FAILED')
  })
})

describe('the helper dying and coming back', () => {
  it('ends a call in progress with FAILED, reports UNREACHABLE, and starts again', async () => {
    const r = track(rig())
    const h = await ready(r)
    const call = await incomingCall(r, h)
    h.emit({ e: 'call', call: 'c1', state: 'streams' })
    const ended: CallEndReason[] = []
    call.onEnded((x) => void ended.push(x))
    h.exit()
    await vi.waitFor(() => expect(ended).toEqual(['FAILED']))
    expect(r.states.some(([s]) => s === 'UNREACHABLE')).toBe(true)
    await vi.waitFor(() => expect(r.helpers.length).toBe(2))
    expect(r.accountCalls.n).toBe(2)
    await vi.waitFor(() => expect(r.helper().sent('configure')).toHaveLength(1))
    r.helper().emit({ e: 'registration', state: 'ok' })
    expect(r.provider.state()).toBe('REGISTERED')
  })

  it('backs off between restarts, up to 60 s, and starts counting again after a registration', async () => {
    const delays: number[] = []
    const r = track(rig({ restartDelayMs: (n) => { delays.push(n); return 1 } }))
    await r.started
    r.helper().exit()
    await vi.waitFor(() => expect(r.helpers.length).toBe(2))
    await vi.waitFor(() => expect(r.helper().sent('configure')).toHaveLength(1))
    r.helper().exit()
    await vi.waitFor(() => expect(r.helpers.length).toBe(3))
    await vi.waitFor(() => expect(r.helper().sent('configure')).toHaveLength(1))
    expect(delays).toEqual([0, 1])
    r.helper().emit({ e: 'registration', state: 'ok' })
    r.helper().exit()
    await vi.waitFor(() => expect(r.helpers.length).toBe(4))
    expect(delays).toEqual([0, 1, 0])
  })

  it('does not restart after stop, sends quit, and kills a helper that does not end', async () => {
    const r = rig()
    const h = await ready(r)
    await r.provider.stop()
    expect(h.sent('quit')).toHaveLength(1)
    expect(h.closed).toBe(true)
    expect(h.killed).toBe(true)
    expect(r.provider.state()).toBe('STOPPED')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(r.helpers).toHaveLength(1)
  })

  it('does not kill a helper that ends by itself after quit', async () => {
    const r = rig()
    const h = await ready(r)
    const stopped = r.provider.stop()
    h.exit()
    await stopped
    expect(h.killed).toBe(false)
  })

  it('kills a helper that never says ready, and starts another', async () => {
    const r = track(rig({ autoReady: false, readyTimeoutMs: 20 }))
    await r.started
    expect(r.helpers[0]?.killed).toBe(true)
    // Each one that does not say ready is replaced in turn; how many by now depends on the machine.
    await vi.waitFor(() => expect(r.helpers.length).toBeGreaterThanOrEqual(2))
  })
})

describe('garbage on the helper output', () => {
  it('ignores lines that are not events, counts them and says so once', async () => {
    const r = track(rig())
    const h = await ready(r)
    h.handlers.stdout('plain text')
    h.handlers.stdout('{"no":"event"}')
    h.handlers.stdout('[1,2,3]')
    h.handlers.stdout('{"e": ')
    h.handlers.stdout('')
    h.emit({ e: 'something-new' })
    expect(r.provider.diagnostics().garbageLines).toBe(4)
    expect(r.logs.filter((l) => l.includes('not an event'))).toHaveLength(1)
    // and it still works
    const call = await incomingCall(r, h)
    expect(call.id).toBe('c1')
  })

  it('ignores an event whose fields have the wrong types', async () => {
    const r = track(rig())
    const h = await ready(r)
    h.emit({ e: 'incoming', call: 7, from: { x: 1 } })
    h.emit({ e: 'registration', state: 5 })
    h.emit({ e: 'call', call: null, state: 'streams' })
    h.emit({ e: 'media', call: 'c1', encryption: 3 })
    expect(r.incoming).toHaveLength(0)
    expect(r.provider.state()).toBe('REGISTERED')
  })
})
