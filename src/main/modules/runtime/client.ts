import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { errorMessage } from '@shared/result'
import {
  MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  ServerFrameSchema,
  type ClientFrame,
  type ClientKind,
  type ConnectionPhase,
  type ConnectionState,
  type EndpointFile,
  type RuntimeIdentity,
  type RuntimeStatus,
  type UiRequest,
  type UiResponse,
} from '@shared/runtime-protocol'
import { handshakeProof, proofsEqual, readEndpoint } from './endpoint'
import { FrameReader, writeFrame } from './framing'

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }

export interface RuntimeClientOptions {
  dataDir: string
  kind: ClientKind
  onPush?: (message: unknown) => void
  /** Shows what the runtime asks for and resolves with the user's answer. Absent: every such request fails. */
  onUiRequest?: (request: UiRequest) => Promise<UiResponse>
  onState?: (state: ConnectionState) => void
  /**
   * Called when no runtime answers. Starts one (it must be safe to call while one is starting). Absent: the
   * client only ever connects to a runtime that something else started.
   */
  ensureRuntime?: () => Promise<void>
  /** How long a started runtime may take to answer before the attempt counts as failed. */
  startTimeoutMs?: number
  requestTimeoutMs?: number
  logger?: (line: string) => void
}

interface Pending {
  resolve: (result: Result) => void
  timer: ReturnType<typeof setTimeout>
}

const unavailable = (message: string): Result => ({ ok: false, error: { code: 'runtime_unavailable', message } })
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A client of the runtime that keeps itself connected. It finds the runtime through the endpoint file, proves
 * itself and checks the runtime's proof, and from then on forwards requests and delivers push messages. When
 * the connection is lost it says so at once (requests fail instead of waiting), and tries again until closed.
 * It holds no state of the runtime: after a reconnect the caller reads everything again.
 */
export class RuntimeClient {
  private socket: Socket | null = null
  private identity: RuntimeIdentity | null = null
  private connected = false
  private closed = false
  private looping = false
  private attempt = 0
  private nextId = 1
  private respawn = true
  private wake: (() => void) | null = null
  private readonly pending = new Map<string, Pending>()
  private current: ConnectionState

  constructor(private readonly options: RuntimeClientOptions) {
    this.current = { phase: 'CONNECTING', detail: 'Looking for the NEXUS runtime.', runtime: null, attempt: 0, since: new Date().toISOString() }
  }

  state(): ConnectionState {
    return this.current
  }

  isConnected(): boolean {
    return this.connected
  }

  private log(line: string): void {
    this.options.logger?.(`runtime-client: ${line}`)
  }

  private setState(phase: ConnectionPhase, detail: string): void {
    if (this.current.phase === phase && this.current.detail === detail && this.current.attempt === this.attempt && this.current.runtime === this.identity) return
    this.current = { phase, detail, runtime: this.identity, attempt: this.attempt, since: this.current.phase === phase ? this.current.since : new Date().toISOString() }
    this.options.onState?.(this.current)
  }

  /** Starts connecting and keeps the connection up. Returns at once. */
  start(): void {
    if (this.looping || this.closed) return
    this.looping = true
    void this.loop().finally(() => {
      this.looping = false
    })
  }

  /** Resolves once connected, or rejects after `timeoutMs`. */
  async whenConnected(timeoutMs = 30_000): Promise<RuntimeIdentity> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (this.connected && this.identity) return this.identity
      if (this.closed) break
      await sleep(25)
    }
    throw new Error(`The NEXUS runtime did not answer (${this.current.phase}: ${this.current.detail}).`)
  }

  /** The user asked to try again now: also allows starting a runtime that was stopped on purpose. */
  retry(): void {
    this.respawn = true
    this.wake?.()
    this.start()
  }

  /** After the runtime said it is stopping, the client does not start another one until told to. */
  allowRespawn(): void {
    this.respawn = true
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
    this.socket?.destroy()
    this.failPending('The client was closed.')
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.resolve(unavailable(message))
    }
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      const endpoint = readEndpoint(this.options.dataDir)
      let failure = 'No NEXUS runtime is running.'
      if (endpoint) {
        this.setState(this.attempt === 0 ? 'CONNECTING' : 'DISCONNECTED', this.attempt === 0 ? 'Connecting to the NEXUS runtime.' : 'NEXUS is attempting to reconnect to its runtime.')
        try {
          await this.session(endpoint)
          // The session ended: the connection was lost after it had been established.
          failure = 'The connection to the NEXUS runtime was lost.'
        } catch (e) {
          failure = errorMessage(e)
          if (failure.startsWith('INCOMPATIBLE:')) {
            this.setState('INCOMPATIBLE', failure.slice('INCOMPATIBLE:'.length).trim())
            await this.pause(5000)
            continue
          }
        }
        if (this.closed) return
      }
      this.attempt += 1
      const absent = !readEndpoint(this.options.dataDir) || failure.includes('ENOENT') || failure.includes('ECONNREFUSED')
      if (absent && this.options.ensureRuntime && this.respawn) {
        this.setState('STARTING_RUNTIME', 'Starting the NEXUS runtime.')
        try {
          await this.options.ensureRuntime()
        } catch (e) {
          this.log(`could not start the runtime: ${errorMessage(e)}`)
          this.setState('DISCONNECTED', `The NEXUS runtime could not be started: ${errorMessage(e)}`)
          await this.pause(Math.min(5000, 500 * this.attempt))
          continue
        }
        // The runtime writes its endpoint once it listens; wait for a new one rather than the stale one.
        const before = endpoint?.bootId ?? null
        const until = Date.now() + (this.options.startTimeoutMs ?? 60_000)
        while (!this.closed && Date.now() < until) {
          const now = readEndpoint(this.options.dataDir)
          if (now && now.bootId !== before) break
          await sleep(100)
        }
        continue
      }
      this.setState('DISCONNECTED', this.respawn ? `${failure} NEXUS is attempting to reconnect.` : 'The NEXUS runtime was stopped.')
      await this.pause(Math.min(5000, 250 * 2 ** Math.min(this.attempt, 5)))
    }
  }

  /** Waits, unless `retry()` or `close()` ends the wait. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  /** One connection: resolves when it ends after having been established, rejects when it never was. */
  private session(endpoint: EndpointFile): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ path: endpoint.pipe })
      const clientNonce = randomBytes(32).toString('hex')
      let established = false
      let settled = false
      let refusal: string | null = null
      const handshakeTimer = setTimeout(() => socket.destroy(new Error('The runtime did not complete the handshake.')), 10_000)
      const send = (frame: ClientFrame): void => void writeFrame(socket, frame)

      const reader = new FrameReader(
        () => MAX_FRAME_BYTES,
        (text) => {
          let frame
          try {
            frame = ServerFrameSchema.safeParse(JSON.parse(text))
          } catch {
            socket.destroy(new Error('The runtime sent a frame that is not JSON.'))
            return
          }
          if (!frame.success) {
            socket.destroy(new Error('The runtime sent a frame that does not match the protocol.'))
            return
          }
          const f = frame.data
          if (f.t === 'error') {
            refusal = f.code === 'protocol_mismatch' ? `INCOMPATIBLE: ${f.message}` : f.message
            if (f.code === 'shutting_down') this.respawn = false
            return
          }
          if (!established) {
            if (f.t === 'challenge') {
              // The runtime proves itself first: a process that only took the pipe name cannot.
              if (!proofsEqual(f.proof, handshakeProof(endpoint.token, 'server', clientNonce, f.nonce))) {
                socket.destroy(new Error('What answered on the pipe is not the NEXUS runtime.'))
                return
              }
              send({ t: 'auth', proof: handshakeProof(endpoint.token, 'client', clientNonce, f.nonce) })
              return
            }
            if (f.t === 'welcome') {
              clearTimeout(handshakeTimer)
              if (f.protocol !== RUNTIME_PROTOCOL_VERSION) {
                refusal = `INCOMPATIBLE: The runtime speaks protocol ${f.protocol}; this window speaks ${RUNTIME_PROTOCOL_VERSION}.`
                socket.destroy()
                return
              }
              established = true
              this.socket = socket
              this.identity = { protocol: f.protocol, version: f.version, pid: f.pid, bootId: f.bootId, startedAt: f.startedAt }
              this.connected = true
              this.attempt = 0
              this.setState('CONNECTING', 'Connected; reading the runtime state.')
              void this.refreshPhase()
              return
            }
            return
          }
          if (f.t === 'res') {
            const pending = this.pending.get(f.id)
            if (!pending) return
            clearTimeout(pending.timer)
            this.pending.delete(f.id)
            pending.resolve(f.result as Result)
          } else if (f.t === 'push') {
            if ((f.message as { kind?: unknown } | null)?.kind === 'runtime') void this.refreshPhase()
            try {
              this.options.onPush?.(f.message)
            } catch (e) {
              this.log(`push handler failed: ${errorMessage(e)}`)
            }
          } else if (f.t === 'ui.req') {
            const answer = this.options.onUiRequest ? this.options.onUiRequest(f.request) : Promise.reject(new Error('This client shows nothing.'))
            answer.then(
              (value) => send({ t: 'ui.res', id: f.id, ok: true, value }),
              (e: unknown) => send({ t: 'ui.res', id: f.id, ok: false, error: errorMessage(e).slice(0, 2000) }),
            )
          }
        },
        () => socket.destroy(new Error('The runtime sent a frame that is too long.')),
      )

      socket.on('connect', () => send({ t: 'hello', protocol: RUNTIME_PROTOCOL_VERSION, client: this.options.kind, nonce: clientNonce }))
      socket.on('data', (data: Buffer) => reader.push(data))
      let failure: Error | null = null
      socket.on('error', (e) => {
        failure = e
      })
      socket.on('close', () => {
        clearTimeout(handshakeTimer)
        if (settled) return
        settled = true
        if (this.socket === socket) {
          this.socket = null
          this.connected = false
        }
        this.failPending('The connection to the NEXUS runtime was lost.')
        if (established) resolve()
        else reject(new Error(refusal ?? (failure ? `${(failure as NodeJS.ErrnoException).code ?? ''} ${failure.message}`.trim() : 'The runtime closed the connection.')))
      })
    })
  }

  /** Reads whether the runtime is still recovering, and says so. */
  private async refreshPhase(): Promise<void> {
    const result = await this.invoke('runtime.status', {})
    if (!this.connected) return
    if (!result.ok) {
      this.setState('READY', 'Connected to the NEXUS runtime.')
      return
    }
    const status = result.value as RuntimeStatus
    if (status.phase === 'RECOVERING') {
      const { workloads, workers } = status.recovery
      this.setState('RECOVERING', `Recovering ${workloads} workload${workloads === 1 ? '' : 's'}; reconciling ${workers} worker${workers === 1 ? '' : 's'}.`)
    } else this.setState('READY', 'Connected to the NEXUS runtime.')
  }

  /** Sends one request. Never rejects and never waits for a reconnect: without a connection it fails at once. */
  invoke(channel: string, input: unknown): Promise<Result> {
    const socket = this.socket
    if (!socket || !this.connected) return Promise.resolve(unavailable('The control plane is disconnected. NEXUS is attempting to reconnect.'))
    return new Promise((resolve) => {
      const id = String(this.nextId++)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: { code: 'internal', message: `The runtime did not answer ${channel} in time.` } })
      }, this.options.requestTimeoutMs ?? 10 * 60_000)
      timer.unref()
      this.pending.set(id, { resolve, timer })
      writeFrame(socket, { t: 'req', id, channel, input } satisfies ClientFrame)
    })
  }
}
