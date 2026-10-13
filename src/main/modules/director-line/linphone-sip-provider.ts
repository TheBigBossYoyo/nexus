import { dirname } from 'node:path'
import { spawnLong, type LongProcess } from '../process/spawn-process'
import {
  normalizeSipIdentity,
  type AudioFormat,
  type CallEndReason,
  type CallSecurity,
  type DirectorVoiceProvider,
  type PlacedCall,
  type VoiceCall,
  type VoiceProviderState,
} from './voice-provider'

/**
 * 0.9.1: the Director's voice line over SIP, carried by nexus-sip.exe (native/nexus-sip), a headless endpoint built on
 * the official Linphone SDK. This file is the NEXUS side of the one conversation they have: newline-delimited JSON
 * over the helper's standard input and output. The helper knows no project, no model and no policy; it registers an
 * account, takes and places calls, and moves 16 kHz mono 16-bit PCM in 20 ms pieces. Who may talk, what is said and
 * what is done about it stays on this side of the pipe (voice-line, voice-session).
 *
 * The password of the account crosses the pipe once, in the `configure` line. It is not kept in a field, not logged
 * and not part of any error: `account()` is asked again at every start of the helper.
 */

export interface SipAccount {
  /** `sip:user@domain` */
  identity: string
  /** Sent in the configure line only. Empty when `register` is false. */
  password: string
  displayName: string
  /** `sip:domain;transport=tls` */
  server: string
  transport: 'tls' | 'tcp' | 'udp'
  mediaEncryption: 'none' | 'srtp' | 'zrtp' | 'dtls'
  mediaEncryptionMandatory: boolean
  stunServer: string | null
  ice: boolean
}

/** The helper process as this file needs it: lines in, lines out (given to the handlers), an end, a kill. */
export interface HelperProcess {
  /** False when the helper's input is closed. */
  write(line: string): boolean
  /** Closes the helper's input: it then ends by itself. */
  end(): void
  /** Kills the helper and everything below it. */
  stop(): Promise<void>
  readonly exited: Promise<unknown>
}

export interface HelperHandlers {
  stdout(line: string): void
  stderr(line: string): void
}

export type SpawnHelper = (file: string, args: string[], handlers: HelperHandlers) => HelperProcess

export interface LinphoneSipProviderOptions {
  /** out/native/nexus-sip.exe (built by scripts/build-sip.mjs). */
  helperPath: string
  /** vendor/linphone-sdk/win64 (fetched by scripts/fetch-linphone-sdk.mjs): the DLLs and share/. */
  runtimeDir: string
  /** Everything the Linphone stack writes goes under here. */
  stateDir: string
  /** Asked at each start of the helper; null when there is no account to register. */
  account: () => Promise<SipAccount | null>
  spawn?: SpawnHelper
  now?: () => number
  log?: (message: string) => void
  /** false: no registration, the helper only listens on `sipPort` (calls straight between two programs, for tests). */
  register?: boolean
  /** The port the helper listens on; -1 (default) is a random one. */
  sipPort?: number
  jitterMs?: number
  /** Delay before the n-th restart (n from 0). Default 1 s doubling, 60 s at most. */
  restartDelayMs?: (attempt: number) => number
  /** How long the helper is given to end after `quit` before it is killed. Default 3 s. */
  quitGraceMs?: number
  /** How long a started helper may take to say `ready`. Default 15 s. */
  readyTimeoutMs?: number
}

const FRAME_BYTES = 640 // 20 ms of 16 kHz mono 16-bit
const FORMAT: AudioFormat = { sampleRate: 16000 }

type Obj = Record<string, unknown>

function str(o: Obj, key: string): string | null {
  const v = o[key]
  return typeof v === 'string' ? v : null
}

/** Starts the helper through the runner of long processes, the one place NEXUS starts them. */
export const spawnSipHelper: SpawnHelper = (file, args, handlers) => {
  // The little Windows needs, and nothing of NEXUS's environment.
  const env: Record<string, string> = {}
  for (const name of ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP']) {
    const value = process.env[name] ?? process.env[name.toUpperCase()]
    if (value !== undefined) env[name] = value
  }
  const child = spawnLong(file, args, {
    cwd: dirname(file),
    env,
    keepStdinOpen: true,
    maxLines: 200,
    onLine: (line, stream) => (stream === 'stdout' ? handlers.stdout(line) : handlers.stderr(line)),
  })
  // The runner has to hand over the child's standard input for this to work: see the note in the report of 0.9.1.
  const io = child as LongProcess & { writeInput?: (text: string) => boolean; endInput?: () => void }
  if (typeof io.writeInput !== 'function' || typeof io.endInput !== 'function') {
    void child.stop().catch(() => undefined)
    throw new Error('The process runner does not give access to the standard input of a long process (writeInput / endInput).')
  }
  const write = io.writeInput.bind(child)
  const end = io.endInput.bind(child)
  return { write, end, stop: () => child.stop(), exited: child.exited }
}

interface CallHost {
  send(command: Obj): boolean
  signalling(): CallSecurity['signalling']
}

class SipCall implements VoiceCall {
  readonly format: AudioFormat = FORMAT
  private ended: CallEndReason | null = null
  private streaming = false
  private mediaEncryption: string | null = null
  private carry = Buffer.alloc(0)
  private markCounter = 0
  private readonly marks = new Map<string, () => void>()
  private readonly audio: ((pcm: Buffer) => void)[] = []
  private readonly digits: ((digit: string) => void)[] = []
  private readonly endListeners: ((reason: CallEndReason) => void)[] = []
  private readonly streamWaiters: { resolve: () => void; reject: (e: Error) => void }[] = []
  private readonly endWaiters: (() => void)[] = []

  constructor(
    readonly id: string,
    readonly direction: 'INBOUND' | 'OUTBOUND',
    readonly remoteIdentity: string,
    readonly identityAssurance: 'TRANSPORT_AUTHENTICATED' | 'CLAIMED',
    private readonly host: CallHost,
  ) {}

  get isEnded(): boolean {
    return this.ended !== null
  }

  answer(): Promise<void> {
    if (this.ended !== null) return Promise.reject(new Error('The call has ended.'))
    if (this.streaming) return Promise.resolve()
    const reached = new Promise<void>((resolve, reject) => {
      this.streamWaiters.push({ resolve, reject })
      setTimeout(() => reject(new Error('The call did not start in time.')), 15_000).unref?.()
    })
    this.host.send({ c: 'answer', call: this.id })
    return reached
  }

  hangUp(): Promise<void> {
    if (this.ended !== null) return Promise.resolve()
    this.host.send({ c: 'hangup', call: this.id })
    return new Promise<void>((resolve) => {
      this.endWaiters.push(resolve)
      setTimeout(resolve, 3000).unref?.()
    })
  }

  sendAudio(pcm: Buffer): void {
    if (this.ended !== null || pcm.length === 0) return
    let data = this.carry.length > 0 ? Buffer.concat([this.carry, pcm]) : pcm
    let offset = 0
    while (data.length - offset >= FRAME_BYTES) {
      this.host.send({ c: 'audio', call: this.id, pcm: data.subarray(offset, offset + FRAME_BYTES).toString('base64') })
      offset += FRAME_BYTES
    }
    // A piece shorter than 20 ms waits for the next one; `drained` plays it out.
    data = data.subarray(offset)
    this.carry = Buffer.from(data)
  }

  clearAudio(): void {
    this.carry = Buffer.alloc(0)
    if (this.ended === null) this.host.send({ c: 'clear', call: this.id })
  }

  drained(): Promise<void> {
    if (this.ended !== null) return Promise.resolve()
    if (this.carry.length > 0) {
      // the last piece of a sentence is played out with silence to the end of its 20 ms
      const tail = Buffer.alloc(FRAME_BYTES)
      this.carry.copy(tail)
      this.carry = Buffer.alloc(0)
      this.host.send({ c: 'audio', call: this.id, pcm: tail.toString('base64') })
    }
    const name = `m${++this.markCounter}`
    return new Promise<void>((resolve) => {
      this.marks.set(name, resolve)
      if (!this.host.send({ c: 'mark', call: this.id, name })) {
        this.marks.delete(name)
        resolve()
      }
    })
  }

  onAudio(listener: (pcm: Buffer) => void): void {
    this.audio.push(listener)
  }

  onDigit(listener: (digit: string) => void): void {
    this.digits.push(listener)
  }

  onEnded(listener: (reason: CallEndReason) => void): void {
    if (this.ended !== null) {
      listener(this.ended)
      return
    }
    this.endListeners.push(listener)
  }

  security(): CallSecurity {
    let media: CallSecurity['media'] = 'UNKNOWN'
    switch (this.mediaEncryption) {
      case 'none':
        media = 'NONE'
        break
      case 'srtp':
        media = 'SRTP'
        break
      case 'zrtp':
        media = 'ZRTP'
        break
      case 'dtls':
        media = 'DTLS_SRTP'
        break
    }
    // Keys agreed between the two ends themselves (ZRTP, DTLS-SRTP), and only once the helper said that is what it
    // negotiated: never assumed from what was asked for.
    return { signalling: this.host.signalling(), media, endToEnd: media === 'ZRTP' || media === 'DTLS_SRTP' }
  }

  // ---- fed by the provider
  onState(state: string, reason: string | null): void {
    if (state === 'streams') {
      this.streaming = true
      for (const w of this.streamWaiters.splice(0)) w.resolve()
    } else if (state === 'ended' || state === 'error') {
      this.finish(reasonToEnd(state, reason))
    }
  }

  onMedia(encryption: string | null): void {
    this.mediaEncryption = encryption
  }

  onPcm(b64: string): void {
    const pcm = Buffer.from(b64, 'base64')
    if (pcm.length === 0) return
    for (const l of this.audio) l(pcm)
  }

  onDigitEvent(digit: string): void {
    for (const l of this.digits) l(digit)
  }

  onPlayed(name: string): void {
    const done = this.marks.get(name)
    if (!done) return
    this.marks.delete(name)
    done()
  }

  /** Ends the call from this side's knowledge: the helper is gone, or told us it ended. */
  finish(reason: CallEndReason): void {
    if (this.ended !== null) return
    this.ended = reason
    this.carry = Buffer.alloc(0)
    for (const w of this.streamWaiters.splice(0)) w.reject(new Error('The call ended before it started.'))
    for (const done of [...this.marks.values()]) done()
    this.marks.clear()
    for (const w of this.endWaiters.splice(0)) w()
    for (const l of this.endListeners.splice(0)) {
      try {
        l(reason)
      } catch {
        // A listener's failure is not the call's.
      }
    }
  }
}

function reasonToEnd(state: string, reason: string | null): CallEndReason {
  if (reason === 'local' || reason === 'timeout') return 'LOCAL_HUNG_UP'
  if (reason === 'remote') return 'REMOTE_HUNG_UP'
  if (reason === 'network') return 'NETWORK_LOST'
  return state === 'error' ? 'FAILED' : 'REMOTE_HUNG_UP'
}

interface Pending {
  resolve: (r: PlacedCall) => void
  timer: ReturnType<typeof setTimeout>
  call: SipCall | null
  /** The ring time ran out before the helper named the call. */
  cancel: boolean
  done: boolean
  timedOut: boolean
}

export class LinphoneSipProvider implements DirectorVoiceProvider {
  readonly kind = 'sip-linphone'
  private readonly now: () => number
  private handlers: { incoming(call: VoiceCall): void; state(state: VoiceProviderState, detail?: string): void } | null = null
  private proc: HelperProcess | null = null
  private ready = false
  private stopping = false
  private current: VoiceProviderState = 'STOPPED'
  private lastDetail: string | undefined
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private generation = 0
  /** What is known about the account, never the password. */
  private cfg: { identity: string | null; domain: string | null; transport: SipAccount['transport'] } = { identity: null, domain: null, transport: 'udp' }
  private registered = false
  private call: SipCall | null = null
  private pending: Pending | null = null
  private garbage = 0
  private garbageLogged = false
  private stderrTail: string[] = []
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null

  constructor(private readonly o: LinphoneSipProviderOptions) {
    this.now = o.now ?? Date.now
  }

  // ---------------------------------------------------------------- the provider
  async start(on: { incoming(call: VoiceCall): void; state(state: VoiceProviderState, detail?: string): void }): Promise<void> {
    this.handlers = on
    this.stopping = false
    await this.launch()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.generation++
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const proc = this.proc
    this.proc = null
    this.ready = false
    if (proc) {
      this.send({ c: 'quit' }, proc)
      proc.end()
      const grace = this.o.quitGraceMs ?? 3000
      const timer = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), grace).unref?.())
      const outcome = await Promise.race([proc.exited.then(() => 'exited' as const), timer])
      if (outcome === 'late') await proc.stop().catch(() => undefined)
    }
    this.failEverything('FAILED')
    this.setState('STOPPED')
  }

  state(): VoiceProviderState {
    return this.current
  }

  /** The network came back (possibly with another address): the registration is renewed. */
  networkChanged(): void {
    if (this.ready) this.send({ c: 'refresh' })
  }

  /** What has been seen on the helper's output that was not an event, and the last of its diagnostics. */
  diagnostics(): { garbageLines: number; stderr: string[] } {
    return { garbageLines: this.garbage, stderr: [...this.stderrTail] }
  }

  async placeCall(to: string, options: { ringSeconds: number }): Promise<PlacedCall> {
    if (this.current !== 'REGISTERED' || !this.ready || this.proc === null) return { outcome: 'FAILED', reason: 'The voice line is not connected.' }
    if (this.pending !== null || this.call !== null) return { outcome: 'FAILED', reason: 'A call is already in progress.' }
    let target: string
    if (/^sips?:[^\s<>"]+$/i.test(to)) target = to
    else {
      const normal = normalizeSipIdentity(to)
      if (normal === null) return { outcome: 'FAILED', reason: 'That is not a SIP address.' }
      target = normal
    }
    this.lastTarget = normalizeSipIdentity(target) ?? target.toLowerCase()
    return new Promise<PlacedCall>((resolve) => {
      const pending: Pending = {
        resolve,
        call: null,
        cancel: false,
        done: false,
        timedOut: false,
        timer: setTimeout(() => {
          if (pending.done) return
          pending.timedOut = true
          if (pending.call) {
            this.send({ c: 'hangup', call: pending.call.id })
            // The end event resolves it; should the helper not answer, it is resolved here.
            setTimeout(() => this.settle(pending, { outcome: 'NO_ANSWER' }), 2000).unref?.()
          } else {
            pending.cancel = true
            setTimeout(() => this.settle(pending, { outcome: 'NO_ANSWER' }), 2000).unref?.()
          }
        }, Math.max(1, options.ringSeconds) * 1000),
      }
      this.pending = pending
      if (!this.send({ c: 'call', to: target })) this.settle(pending, { outcome: 'FAILED', reason: 'The voice line is not connected.' })
    })
  }

  // ---------------------------------------------------------------- the helper's life
  private launch(): Promise<void> {
    const generation = ++this.generation
    return this.launchInner(generation)
  }

  private async launchInner(generation: number): Promise<void> {
    let account: SipAccount | null
    try {
      account = await this.o.account()
    } catch {
      this.setState('UNREACHABLE', 'The account could not be read.')
      this.scheduleRestart(generation)
      return
    }
    if (generation !== this.generation || this.stopping) return
    const register = this.o.register ?? true
    if (account === null) {
      this.setState('STOPPED', 'No SIP account is set up.')
      return
    }
    const identity = normalizeSipIdentity(account.identity)
    this.cfg = { identity, domain: identity?.split('@')[1] ?? null, transport: account.transport }
    this.registered = false
    this.setState('CONNECTING')
    let proc: HelperProcess
    try {
      proc = (this.o.spawn ?? spawnSipHelper)(this.o.helperPath, ['--runtime', this.o.runtimeDir, '--state', this.o.stateDir], {
        stdout: (line) => this.onStdout(line, generation),
        stderr: (line) => this.onStderr(line),
      })
    } catch (e) {
      this.setState('UNREACHABLE', 'The SIP helper could not be started.')
      this.o.log?.(`director-line: the SIP helper could not be started (${e instanceof Error ? e.message : 'unknown'})`)
      this.scheduleRestart(generation)
      return
    }
    this.proc = proc
    void proc.exited.then(() => this.onExit(proc, generation))

    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject }
      setTimeout(() => reject(new Error('The SIP helper did not say it was ready.')), this.o.readyTimeoutMs ?? 15_000).unref?.()
    })
    try {
      await ready
    } catch (e) {
      this.readyWaiter = null
      if (generation === this.generation && !this.stopping) {
        this.o.log?.(`director-line: ${e instanceof Error ? e.message : 'the SIP helper failed'}`)
        void proc.stop().catch(() => undefined)
      }
      return
    }
    this.readyWaiter = null
    if (generation !== this.generation || this.stopping) return
    // The only line that carries the password. It is built, written and dropped.
    const configure: Obj = {
      c: 'configure',
      identity: account.identity,
      displayName: account.displayName,
      server: account.server,
      transport: account.transport,
      mediaEncryption: account.mediaEncryption,
      mediaEncryptionMandatory: account.mediaEncryptionMandatory,
      stunServer: account.stunServer,
      ice: account.ice,
      jitterMs: this.o.jitterMs ?? 0,
      register,
      sipPort: this.o.sipPort ?? -1,
    }
    if (register) configure.password = account.password
    this.send(configure, proc)
    delete configure.password
    if (!register) {
      // Nothing to register: the helper only listens.
      this.registered = false
      this.attempt = 0
      this.setState('REGISTERED', 'Listening without registration.')
    }
  }

  private scheduleRestart(generation: number): void {
    if (this.stopping || generation !== this.generation || this.restartTimer) return
    const delay = (this.o.restartDelayMs ?? defaultRestartDelay)(this.attempt++)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      void this.launch()
    }, delay)
    this.restartTimer.unref?.()
  }

  private onExit(proc: HelperProcess, generation: number): void {
    if (this.proc !== proc) return
    this.proc = null
    this.ready = false
    this.registered = false
    if (this.readyWaiter) {
      this.readyWaiter.reject(new Error('The SIP helper ended before it was ready.'))
      this.readyWaiter = null
    }
    this.failEverything('FAILED')
    if (this.stopping || generation !== this.generation) return
    this.setState('UNREACHABLE', 'The SIP helper stopped; starting it again.')
    this.scheduleRestart(generation)
  }

  /** A call in progress ends, a call being placed fails: their helper is gone. */
  private failEverything(reason: CallEndReason): void {
    const call = this.call
    this.call = null
    const pending = this.pending
    if (pending) this.settle(pending, { outcome: 'FAILED', reason: 'The voice line stopped.' })
    call?.finish(reason)
  }

  private settle(pending: Pending, result: PlacedCall): void {
    if (pending.done) return
    pending.done = true
    clearTimeout(pending.timer)
    if (this.pending === pending) this.pending = null
    pending.resolve(result)
  }

  private setState(state: VoiceProviderState, detail?: string): void {
    if (state === this.current && detail === this.lastDetail) return
    this.current = state
    this.lastDetail = detail
    try {
      this.handlers?.state(state, detail)
    } catch {
      // A listener's failure is not the provider's.
    }
  }

  private send(command: Obj, proc: HelperProcess | null = this.proc): boolean {
    if (proc === null) return false
    try {
      return proc.write(`${JSON.stringify(command)}\n`)
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------- what the helper says
  private onStderr(line: string): void {
    this.stderrTail.push(line.slice(0, 500))
    if (this.stderrTail.length > 50) this.stderrTail.shift()
    // The helper's own words; the stack's routine complaints stay in the tail above.
    if (line.startsWith('nexus-sip:')) this.o.log?.(`director-line: ${line.slice(0, 300)}`)
  }

  private onStdout(line: string, generation: number): void {
    if (generation !== this.generation) return
    const text = line.trim()
    if (text === '') return
    let event: Obj
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof (parsed as Obj).e !== 'string') throw new Error('not an event')
      event = parsed as Obj
    } catch {
      this.garbage++
      if (!this.garbageLogged) {
        this.garbageLogged = true
        this.o.log?.('director-line: the SIP helper printed something that is not an event; such lines are ignored')
      }
      return
    }
    try {
      this.onEvent(event)
    } catch {
      this.o.log?.('director-line: an event from the SIP helper could not be handled')
    }
  }

  private onEvent(event: Obj): void {
    const kind = event.e as string
    switch (kind) {
      case 'ready':
        this.ready = true
        this.readyWaiter?.resolve()
        return
      case 'registration':
        return this.onRegistration(str(event, 'state'), str(event, 'reason'))
      case 'incoming':
        return this.onIncoming(event)
      case 'call':
        return this.onCall(event)
      case 'media': {
        const call = this.callFor(event)
        if (call) call.onMedia(str(event, 'encryption'))
        return
      }
      case 'audio': {
        const call = this.callFor(event)
        const pcm = str(event, 'pcm')
        if (call && pcm) call.onPcm(pcm)
        return
      }
      case 'dtmf': {
        const call = this.callFor(event)
        const digit = str(event, 'digit')
        if (call && digit && /^[0-9*#A-D]$/.test(digit)) call.onDigitEvent(digit)
        return
      }
      case 'played': {
        const call = this.callFor(event)
        const name = str(event, 'name')
        if (call && name) call.onPlayed(name)
        return
      }
      case 'error':
        this.o.log?.(`director-line: the SIP helper reported an error (${(str(event, 'message') ?? '').slice(0, 200)})`)
        return
      default:
        return
    }
  }

  private callFor(event: Obj): SipCall | null {
    return this.call !== null && str(event, 'call') === this.call.id ? this.call : null
  }

  private onRegistration(state: string | null, reason: string | null): void {
    if (this.o.register === false) return
    switch (state) {
      case 'ok':
        this.registered = true
        this.attempt = 0
        this.setState('REGISTERED')
        break
      case 'progress':
      case 'none':
      case 'cleared':
        this.registered = false
        this.setState('CONNECTING', reason ?? undefined)
        break
      case 'failed': {
        this.registered = false
        const refused = /^\s*(401|403|407)\b/.test(reason ?? '') || /forbidden|unauthori[sz]ed|bad credentials/i.test(reason ?? '')
        this.setState(refused ? 'REJECTED' : 'UNREACHABLE', reason ?? undefined)
        break
      }
    }
  }

  private makeHost(): CallHost {
    return {
      send: (command) => this.send(command),
      signalling: () => {
        if (this.cfg.transport !== 'tls') return 'NONE'
        return this.registered ? 'TLS' : 'UNKNOWN'
      },
    }
  }

  private onIncoming(event: Obj): void {
    const id = str(event, 'call')
    const from = str(event, 'from')
    if (id === null) return
    const decline = (why: string): void => {
      this.send({ c: 'decline', call: id })
      this.o.log?.(`director-line: an incoming SIP call was declined (${why})`)
    }
    if (this.call !== null || this.pending !== null) return decline('busy')
    const identity = from === null ? null : normalizeSipIdentity(from)
    if (identity === null) return decline('its caller could not be read')
    // The best the transport says: the call came to the account NEXUS registered, and its From names a user of that
    // same domain. Whether the proxy itself checks that a caller may use a From of its domain is not established, so
    // this is a claim the server may or may not vouch for; the voice line asks for the PIN accordingly. A call that
    // came straight to this PC, or from another domain, is only ever CLAIMED.
    const sameDomain = this.cfg.domain !== null && identity.split('@')[1] === this.cfg.domain
    const assurance = event.viaRegisteredAccount === true && this.registered && sameDomain ? 'TRANSPORT_AUTHENTICATED' : 'CLAIMED'
    const call = new SipCall(id, 'INBOUND', identity, assurance, this.makeHost())
    this.call = call
    const on = this.handlers
    if (!on) return decline('nobody is listening')
    try {
      on.incoming(call)
    } catch {
      this.send({ c: 'hangup', call: id })
    }
  }

  private onCall(event: Obj): void {
    const id = str(event, 'call')
    const state = str(event, 'state')
    const reason = str(event, 'reason')
    if (id === null || state === null) return
    if (state === 'outgoing' && this.pending !== null && this.call === null) {
      const pending = this.pending
      const call = new SipCall(id, 'OUTBOUND', this.outboundIdentity(), this.outboundAssurance(), this.makeHost())
      pending.call = call
      this.call = call
      if (pending.cancel) this.send({ c: 'hangup', call: id })
      return
    }
    if (this.call === null || this.call.id !== id) {
      // The helper could not even start a call it was asked to place.
      if (id === 'none' && state === 'error' && this.pending !== null) this.settle(this.pending, { outcome: 'FAILED', reason: reason ?? 'The call could not be placed.' })
      return
    }
    const call = this.call
    const pending = this.pending
    call.onState(state, reason)
    if (state === 'streams' && pending !== null && pending.call === call) {
      this.settle(pending, { outcome: 'ANSWERED', call })
    }
    if (state === 'ended' || state === 'error') {
      this.call = null
      if (pending !== null && pending.call === call) {
        this.settle(pending, this.outcomeOf(pending, state, reason))
      }
    }
  }

  private lastTarget: string | null = null

  private outboundIdentity(): string {
    return this.lastTarget ?? 'sip:unknown@invalid.example'
  }

  private outboundAssurance(): 'TRANSPORT_AUTHENTICATED' | 'CLAIMED' {
    const domain = this.lastTarget?.split('@')[1] ?? null
    return this.registered && domain !== null && domain === this.cfg.domain ? 'TRANSPORT_AUTHENTICATED' : 'CLAIMED'
  }

  private outcomeOf(pending: Pending, state: string, reason: string | null): PlacedCall {
    if (pending.timedOut) return { outcome: 'NO_ANSWER' }
    switch (reason) {
      case 'busy':
        return { outcome: 'BUSY' }
      case 'declined':
        return { outcome: 'DECLINED' }
      case 'no_answer':
      case 'no_response':
      case 'timeout':
        return { outcome: 'NO_ANSWER' }
      default:
        return { outcome: 'FAILED', ...(reason !== null ? { reason } : { reason: state }) }
    }
  }
}

function defaultRestartDelay(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt, 10))
}
