import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { newId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import {
  ClientFrameSchema,
  HANDSHAKE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_HANDSHAKE_FRAME_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  UiResponseSchema,
  type ClientKind,
  type RuntimeErrorCode,
  type RuntimeIdentity,
  type ServerFrame,
  type UiRequest,
  type UiResponse,
} from '@shared/runtime-protocol'
import { FrameReader, writeFrame } from './framing'
import { handshakeProof, proofsEqual } from './endpoint'

/** A client that does not read is dropped once this much is waiting for it; the runtime never blocks on a window. */
const MAX_PENDING_BYTES = 64 * 1024 * 1024
/** Connections that have not completed the handshake, and connections in all. Beyond these a new one is closed at once. */
const MAX_UNAUTHENTICATED = 16
const MAX_CONNECTIONS = 64

export interface RuntimeServerOptions {
  pipe: string
  token: string
  identity: RuntimeIdentity
  /** Answers one request. The channel and the input are validated by the dispatcher, not here. */
  dispatch: (channel: string, input: unknown, client: { kind: ClientKind; id: string }) => Promise<unknown>
  onClientsChange?: () => void
  logger?: (line: string) => void
  handshakeTimeoutMs?: number
  /**
   * 0.8: narrows who may open the pipe at all, once it listens: the user and the system, nothing below medium
   * integrity. Called before the first connection is served. When it fails the server does not start: a
   * runtime that contains project code must not be one that project code can connect to.
   */
  protect?: (pipe: string) => Promise<void>
}

interface Connection {
  id: string
  socket: Socket
  kind: ClientKind | null
  clientNonce: string | null
  serverNonce: string | null
  authenticated: boolean
  timer: ReturnType<typeof setTimeout> | null
}

interface PendingUi {
  connection: string
  resolve: (value: UiResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The runtime's side of the local protocol: accepts connections on one named pipe, completes the mutual
 * handshake, answers requests through the dispatcher, and sends push messages to every authenticated client.
 * It has no knowledge of what the channels do.
 */
export class RuntimeServer {
  private server: Server | null = null
  private readonly connections = new Map<string, Connection>()
  private readonly pendingUi = new Map<string, PendingUi>()
  private closing = false

  constructor(private readonly options: RuntimeServerOptions) {}

  /** Starts listening. Rejects when the pipe name is taken, which for a random name means something is wrong. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket))
      server.once('error', reject)
      server.listen({ path: this.options.pipe, exclusive: true }, () => {
        server.off('error', reject)
        server.on('error', (e) => this.log(`server error: ${errorMessage(e)}`))
        this.server = server
        if (!this.options.protect) return resolve()
        // The opening that sets the protection is itself a connection: it says nothing and is dropped like any
        // other that does not complete the handshake.
        this.options.protect(this.options.pipe).then(resolve, (e: unknown) => {
          this.server = null
          server.close()
          reject(e instanceof Error ? e : new Error(String(e)))
        })
      })
    })
  }

  private log(line: string): void {
    this.options.logger?.(`runtime-ipc: ${line}`)
  }

  clientCount(kind?: ClientKind): number {
    let n = 0
    for (const c of this.connections.values()) if (c.authenticated && (!kind || c.kind === kind)) n += 1
    return n
  }

  private accept(socket: Socket): void {
    let unauthenticated = 0
    for (const c of this.connections.values()) if (!c.authenticated) unauthenticated += 1
    // Anyone who can open the pipe can open it often; what that costs the runtime is bounded.
    if (this.closing || unauthenticated >= MAX_UNAUTHENTICATED || this.connections.size >= MAX_CONNECTIONS) {
      socket.destroy()
      return
    }
    const connection: Connection = { id: newId(), socket, kind: null, clientNonce: null, serverNonce: null, authenticated: false, timer: null }
    this.connections.set(connection.id, connection)
    connection.timer = setTimeout(() => this.refuse(connection, 'handshake_timeout', 'The handshake was not completed in time.'), this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    const reader = new FrameReader(
      () => (connection.authenticated ? MAX_FRAME_BYTES : MAX_HANDSHAKE_FRAME_BYTES),
      (text) => this.onFrame(connection, text),
      () => this.refuse(connection, 'frame_too_long', 'The frame is longer than allowed.'),
    )
    socket.on('data', (data: Buffer) => reader.push(data))
    socket.on('error', () => undefined)
    socket.on('close', () => this.drop(connection))
  }

  private send(connection: Connection, frame: ServerFrame): void {
    const pending = writeFrame(connection.socket, frame)
    if (pending > MAX_PENDING_BYTES) {
      this.log(`client ${connection.id} does not read; dropped`)
      connection.socket.destroy()
    }
  }

  private refuse(connection: Connection, code: RuntimeErrorCode, message: string): void {
    if (!connection.socket.destroyed) {
      writeFrame(connection.socket, { t: 'error', code, message } satisfies ServerFrame)
      connection.socket.end()
      // A peer that keeps the pipe open is not waited for.
      setTimeout(() => connection.socket.destroy(), 250).unref()
    }
  }

  private drop(connection: Connection): void {
    if (connection.timer) clearTimeout(connection.timer)
    if (!this.connections.delete(connection.id)) return
    for (const [id, pending] of this.pendingUi) {
      if (pending.connection !== connection.id) continue
      clearTimeout(pending.timer)
      this.pendingUi.delete(id)
      pending.reject(new Error('The window closed before it answered.'))
    }
    if (connection.authenticated) this.options.onClientsChange?.()
  }

  private onFrame(connection: Connection, text: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return this.refuse(connection, 'bad_frame', 'The frame is not JSON.')
    }
    const parsed = ClientFrameSchema.safeParse(raw)
    if (!parsed.success) return this.refuse(connection, 'bad_frame', 'The frame does not match the protocol.')
    const frame = parsed.data

    if (!connection.authenticated) {
      if (frame.t === 'hello' && connection.clientNonce === null) {
        if (frame.protocol !== RUNTIME_PROTOCOL_VERSION) return this.refuse(connection, 'protocol_mismatch', `This runtime speaks protocol ${RUNTIME_PROTOCOL_VERSION}; the client speaks ${frame.protocol}.`)
        connection.kind = frame.client
        connection.clientNonce = frame.nonce
        connection.serverNonce = randomBytes(32).toString('hex')
        return this.send(connection, { t: 'challenge', protocol: RUNTIME_PROTOCOL_VERSION, nonce: connection.serverNonce, proof: handshakeProof(this.options.token, 'server', frame.nonce, connection.serverNonce) })
      }
      if (frame.t === 'auth' && connection.clientNonce !== null && connection.serverNonce !== null) {
        if (!proofsEqual(frame.proof, handshakeProof(this.options.token, 'client', connection.clientNonce, connection.serverNonce))) return this.refuse(connection, 'auth_failed', 'The client could not prove that it holds the runtime token.')
        connection.authenticated = true
        if (connection.timer) clearTimeout(connection.timer)
        connection.timer = null
        this.send(connection, { t: 'welcome', ...this.options.identity })
        this.options.onClientsChange?.()
        return
      }
      // Anything else before the handshake is complete, including a request, ends the connection.
      return this.refuse(connection, 'auth_failed', 'The handshake is not complete.')
    }

    if (frame.t === 'ping') return this.send(connection, { t: 'pong' })
    if (frame.t === 'req') {
      const client = { kind: connection.kind ?? 'tool', id: connection.id }
      void this.options
        .dispatch(frame.channel, frame.input, client)
        .catch((e: unknown) => ({ ok: false, error: { code: 'internal', message: errorMessage(e) } }))
        .then((result) => {
          if (this.connections.has(connection.id)) this.send(connection, { t: 'res', id: frame.id, result })
        })
      return
    }
    if (frame.t === 'ui.res') {
      const pending = this.pendingUi.get(frame.id)
      // Only the connection that was asked may answer.
      if (!pending || pending.connection !== connection.id) return
      clearTimeout(pending.timer)
      this.pendingUi.delete(frame.id)
      const value = frame.ok ? UiResponseSchema.safeParse(frame.value) : null
      if (value?.success) pending.resolve(value.data)
      else pending.reject(new Error(frame.error ?? 'The window could not show the request.'))
      return
    }
    // `hello` or `auth` after the handshake.
    this.refuse(connection, 'bad_frame', 'The handshake is already complete.')
  }

  /** Sends a push message to every authenticated client. A message that cannot be serialized is dropped. */
  broadcast(message: unknown): void {
    if (this.connections.size === 0) return
    for (const connection of this.connections.values()) {
      if (connection.authenticated) this.send(connection, { t: 'push', message })
    }
  }

  /**
   * Asks the connected desktop to show something to the user and waits for the answer. Fails when no window is
   * connected: a question nobody can see is never answered "yes".
   */
  requestUi(request: UiRequest, timeoutMs = 10 * 60_000): Promise<UiResponse> {
    const desktop = [...this.connections.values()].find((c) => c.authenticated && c.kind === 'desktop')
    if (!desktop) return Promise.reject(new Error('No NEXUS window is connected to answer this.'))
    return new Promise((resolve, reject) => {
      const id = newId()
      const timer = setTimeout(() => {
        this.pendingUi.delete(id)
        reject(new Error('The window did not answer in time.'))
      }, timeoutMs)
      timer.unref()
      this.pendingUi.set(id, { connection: desktop.id, resolve, reject, timer })
      this.send(desktop, { t: 'ui.req', id, request })
    })
  }

  /** Stops accepting, tells the clients why, and closes every connection. */
  close(): Promise<void> {
    this.closing = true
    for (const connection of this.connections.values()) this.refuse(connection, 'shutting_down', 'The runtime is stopping.')
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      setTimeout(() => {
        for (const connection of this.connections.values()) connection.socket.destroy()
        resolve()
      }, 1000).unref()
    })
  }
}
