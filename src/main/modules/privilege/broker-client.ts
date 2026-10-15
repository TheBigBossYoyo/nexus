import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PrivilegedCapability } from '@shared/privilege'
import { spawnLong, type LongProcess, type SpawnLongOptions } from '../process/spawn-process'

/**
 * 0.9.1: NEXUS's side of the temporary administrator broker (native/nexus-elevate). The runtime starts the helper as
 * a relay, unelevated; the relay raises the one UAC prompt, checks that the pipe it reaches belongs to the elevated
 * process Windows started, and passes lines. The broker's hello carries the session key; every request after it is
 * numbered and signed, every answer too, and an answer that is not exactly the next one, or not signed with the
 * key, ends the session: nothing is believed of a broker that cannot prove it is the one that was started.
 *
 * This class is the only holder of the key and of the relay's input. Agents never see either.
 */

export interface BrokerExecRequest {
  opId: string
  capability: PrivilegedCapability
  executable: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  timeoutMs: number
  sha256?: string
  inputs: { arg: number; sha256: string }[]
  files?: { path: string; sha256: string }[]
}

export type BrokerExecResult =
  | { kind: 'result'; exitCode: number; durationMs: number; timedOut: boolean; executable: string; stagedSha256: string | null; leftoverEnded: number; leftover: string | null; files?: { arg: number; name: string; text: string }[]; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }
  | { kind: 'refused'; reason: string }
  | { kind: 'lost'; reason: string }

export type BrokerStart =
  | { ok: true; client: ElevatedBrokerClient }
  | { ok: false; outcome: 'DECLINED' | 'FAILED'; reason: string }

export interface ElevatedBrokerOptions {
  helperPath: string
  runtimePid: number
  session: string
  expiresAt: Date
  capabilities: readonly PrivilegedCapability[]
  /** Folder the helper is started in (no file of it is used). */
  cwd: string
  /** Starts the broker unelevated (tests of the protocol only): no UAC prompt, nothing the user does not have. */
  unelevatedTest?: { stagingDir: string }
  /** How long the owner has to answer the UAC prompt. Default 5 minutes. */
  consentTimeoutMs?: number
  spawn?: (file: string, args: readonly string[], options: SpawnLongOptions) => LongProcess
  log?: (line: string) => void
  /** The broker ended, for whatever reason (told to, the session's time, the relay or the broker died). */
  onEnded?: (reason: string) => void
}

interface Pending {
  resolve: (body: Record<string, unknown>) => void
  timer: ReturnType<typeof setTimeout>
}

const sign = (key: Buffer, session: string, direction: 'q' | 'r', seq: string, body: string): string => createHmac('sha256', key).update(`${session}\n${direction}\n${seq}\n${body}`).digest('hex')

const sameHex = (a: string, b: string): boolean => a.length === b.length && /^[0-9a-f]+$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))

export class ElevatedBrokerClient {
  private key: Buffer | null = null
  private sent = 0
  private received = 0
  private readonly pending: Pending[] = []
  private endedReason: string | null = null
  private helloWaiter: ((hello: Record<string, unknown> | { failure: 'DECLINED' | 'FAILED'; reason: string }) => void) | null = null
  brokerPid: number | null = null
  /** The broker's pipe (its name is no secret: only the relay that started it is accepted on it). */
  pipeName: string | null = null
  elevated = false

  private constructor(
    private readonly o: ElevatedBrokerOptions,
    private readonly proc: { current: LongProcess | null },
  ) {}

  /** Starts the relay and the broker (the UAC prompt, unless in test), and waits for the broker's hello. */
  static async start(o: ElevatedBrokerOptions): Promise<BrokerStart> {
    const holder: { current: LongProcess | null } = { current: null }
    const client = new ElevatedBrokerClient(o, holder)
    const hello = new Promise<Record<string, unknown> | { failure: 'DECLINED' | 'FAILED'; reason: string }>((resolve) => {
      client.helloWaiter = resolve
    })
    const args = ['session', '--runtime-pid', String(o.runtimePid), '--session', o.session, '--expires-unix', String(Math.floor(o.expiresAt.getTime() / 1000)), '--capabilities', o.capabilities.join(',')]
    if (o.unelevatedTest) args.push('--unelevated-test', '--staging', o.unelevatedTest.stagingDir)
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    try {
      holder.current = (o.spawn ?? spawnLong)(o.helperPath, args, {
        cwd: o.cwd,
        // Nothing of NEXUS's environment: the relay needs Windows' own folders and nothing else.
        env: { SystemRoot: systemRoot, windir: systemRoot, PATH: `${systemRoot}\\System32` },
        keepStdinOpen: true,
        // The hello carries the session key: no line of this process is kept (second review, informational).
        maxLines: 0,
        lineLimit: 4 * 1024 * 1024,
        onLine: (line, stream) => (stream === 'stdout' ? client.onLine(line) : o.log?.(`privilege broker: ${line.slice(0, 200)}`)),
      })
    } catch (e) {
      return { ok: false, outcome: 'FAILED', reason: `The broker could not be started (${e instanceof Error ? e.message : 'unknown'}).` }
    }
    void holder.current.exited.then(({ code }) => {
      if (code === 5) client.helloWaiter?.({ failure: 'DECLINED', reason: 'The administrator prompt was declined.' })
      client.helloWaiter?.({ failure: 'FAILED', reason: `The broker's relay ended (code ${code ?? 'none'}).` })
      client.lost(client.key === null ? 'never started' : 'the relay ended')
    })
    const timer = setTimeout(() => client.helloWaiter?.({ failure: 'FAILED', reason: 'No answer to the administrator prompt in time.' }), o.consentTimeoutMs ?? 5 * 60_000)
    const first = await hello
    clearTimeout(timer)
    client.helloWaiter = null
    if ('failure' in first) {
      await holder.current.stop().catch(() => undefined)
      return { ok: false, outcome: first.failure as 'DECLINED' | 'FAILED', reason: first.reason as string }
    }
    return { ok: true, client }
  }

  get alive(): boolean {
    return this.key !== null && this.endedReason === null
  }

  get endReason(): string | null {
    return this.endedReason
  }

  private onLine(line: string): void {
    const tab1 = line.indexOf('\t')
    const tab2 = tab1 < 0 ? -1 : line.indexOf('\t', tab1 + 1)
    if (tab1 < 0 || tab2 < 0) return this.lost('a line from the broker is not in the protocol')
    const seq = line.slice(0, tab1)
    const mac = line.slice(tab1 + 1, tab2)
    const text = line.slice(tab2 + 1)
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      body = parsed as Record<string, unknown>
    } catch {
      return this.lost('a line from the broker could not be read')
    }
    if (seq === 's') {
      // The relay's own lines are unsigned: they mean something only before the broker's hello (second review).
      if (this.key !== null) return
      // The relay's own words: who the broker is, or why there is none.
      if (body.e === 'relay' && typeof body.brokerPid === 'number') {
        this.brokerPid = body.brokerPid
        this.pipeName = typeof body.pipe === 'string' ? body.pipe : null
      }
      else if (body.e === 'declined') this.helloWaiter?.({ failure: 'DECLINED', reason: 'The administrator prompt was declined.' })
      else if (body.e === 'failed') this.helloWaiter?.({ failure: 'FAILED', reason: typeof body.reason === 'string' ? body.reason.slice(0, 400) : 'The broker could not be started.' })
      return
    }
    if (seq === '0') {
      // The hello: once, before anything else, from the broker the relay checked.
      if (this.key !== null || body.e !== 'hello' || body.session !== this.o.session || typeof body.key !== 'string') return this.lost('an unexpected hello')
      const key = Buffer.from(body.key, 'base64')
      if (key.length !== 32) return this.lost('a key of the wrong size')
      const caps = Array.isArray(body.capabilities) ? body.capabilities : []
      if (caps.length !== this.o.capabilities.length || !this.o.capabilities.every((c) => caps.includes(c))) return this.lost('the broker holds other capabilities than were asked')
      this.key = key
      this.elevated = body.elevated === true
      if (!this.elevated && this.o.unelevatedTest === undefined) return this.lost('the broker is not elevated')
      this.helloWaiter?.({ ...body, key: undefined })
      return
    }
    if (this.key === null) return this.lost('a line before the hello')
    if (seq !== String(this.received + 1) || !sameHex(mac, sign(this.key, this.o.session, 'r', seq, text))) return this.lost('an answer that is not the next signed one')
    this.received++
    if (body.e === 'ended') {
      const leftover = typeof body.leftover === 'string' && body.leftover.trim() !== '' ? ` (may still be running: ${body.leftover.slice(0, 300)})` : ''
      this.lost(typeof body.reason === 'string' ? `ended: ${body.reason}${leftover}` : `ended${leftover}`)
      return
    }
    const waiter = this.pending.shift()
    if (waiter === undefined) return this.lost('an answer nobody asked for')
    clearTimeout(waiter.timer)
    waiter.resolve(body)
  }

  /** The broker is gone or not to be believed: every waiting request is answered as lost, and the session ends. */
  private lost(reason: string): void {
    if (this.endedReason !== null) return
    this.endedReason = reason
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer)
      p.resolve({ e: 'lost', reason })
    }
    this.helloWaiter?.({ failure: 'FAILED', reason: `The broker could not be verified (${reason}).` })
    this.proc.current?.endInput()
    void this.proc.current?.stop().catch(() => undefined)
    try {
      this.o.onEnded?.(reason)
    } catch {
      // A listener's failure is not the broker's.
    }
  }

  private request(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.alive || this.key === null || this.proc.current === null) return Promise.resolve({ e: 'lost', reason: this.endedReason ?? 'no broker' })
    const text = JSON.stringify(body)
    const seq = String(++this.sent)
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.lost('a request was not answered in time'), timeoutMs)
      this.pending.push({ resolve, timer })
      if (!this.proc.current?.writeInput(`${seq}\t${sign(this.key as Buffer, this.o.session, 'q', seq, text)}\t${text}\n`)) this.lost('the relay cannot be written to')
    })
  }

  async ping(): Promise<boolean> {
    return (await this.request({ op: 'ping' }, 15_000)).e === 'pong'
  }

  async exec(req: BrokerExecRequest): Promise<BrokerExecResult> {
    const body: Record<string, unknown> = { op: 'exec', opId: req.opId, capability: req.capability, executable: req.executable, args: req.args, env: req.env, timeoutMs: req.timeoutMs, inputs: req.inputs }
    if (req.cwd !== undefined) body.cwd = req.cwd
    if (req.sha256 !== undefined) body.sha256 = req.sha256
    if (req.files !== undefined && req.files.length > 0) body.files = req.files
    // The broker's own deadline plus the time to end what was left and stage files.
    const answer = await this.request(body, req.timeoutMs + 60_000)
    const str = (k: string): string => (typeof answer[k] === 'string' ? (answer[k] as string) : '')
    if (answer.e === 'result')
      return {
        kind: 'result',
        exitCode: typeof answer.exitCode === 'number' ? answer.exitCode : -1,
        durationMs: typeof answer.durationMs === 'number' ? answer.durationMs : 0,
        timedOut: answer.timedOut === true,
        executable: str('executable'),
        stagedSha256: typeof answer.stagedSha256 === 'string' ? answer.stagedSha256 : null,
        leftoverEnded: typeof answer.leftoverEnded === 'number' ? answer.leftoverEnded : 0,
        // 0.9.1 (review F9): what the program handed to Windows (an installation, a service) and may still be running.
        leftover: typeof answer.leftover === 'string' && answer.leftover.trim() !== '' ? answer.leftover.slice(0, 400) : null,
        // 0.9.1 (second review, M1): the result and log files, written in the broker's staging and returned as text.
        files: Array.isArray(answer.files)
          ? (answer.files as unknown[]).flatMap((f) => {
              const o = f as { arg?: unknown; name?: unknown; text?: unknown }
              return typeof o === 'object' && o !== null && typeof o.name === 'string' && typeof o.text === 'string' ? [{ arg: typeof o.arg === 'number' ? o.arg : -1, name: o.name.slice(0, 120), text: o.text.slice(0, 65_536) }] : []
            })
          : [],
        stdout: str('stdout'),
        stderr: str('stderr'),
        stdoutTruncated: answer.stdoutTruncated === true,
        stderrTruncated: answer.stderrTruncated === true,
      }
    if (answer.e === 'refused' || answer.e === 'rejected') return { kind: 'refused', reason: str('reason').slice(0, 400) || 'refused by the broker' }
    return { kind: 'lost', reason: str('reason') || 'the broker is gone' }
  }

  /** Ends the session: the broker ends what it started, removes its staged files and exits. */
  async end(): Promise<void> {
    if (this.alive) await this.request({ op: 'end' }, 15_000)
    if (this.endedReason === null) this.lost('ended')
    this.proc.current?.endInput()
    await Promise.race([this.proc.current?.exited ?? Promise.resolve(), new Promise((r) => setTimeout(r, 10_000))])
  }
}
