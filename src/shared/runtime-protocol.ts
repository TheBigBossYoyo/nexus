import { z } from 'zod'

/**
 * NEXUS 0.7: the local protocol between a client (the desktop window's main process, a test) and the runtime
 * process. Frames are JSON objects, one per line, over a Windows named pipe (a Unix socket elsewhere). Nothing
 * listens on the network.
 *
 * A connection is useless until both sides have proved that they hold the runtime's token, which is a file only
 * the Windows user can read. The token itself never crosses the pipe: each side sends an HMAC over the two
 * nonces, so a process that squats on the pipe name learns nothing it can replay.
 *
 * After the handshake a client may send requests. A request names one channel of the closed IPC contract
 * (`src/shared/ipc.ts`) and its input, which the runtime validates with that channel's schema before any handler
 * runs. There is no frame that carries a command, a path to open or code to evaluate.
 */

/** Raised when a frame's meaning changes. A client and a runtime with different versions do not talk. */
export const RUNTIME_PROTOCOL_VERSION = 1

/** One frame may not be longer than this (bytes of UTF-8, including the newline). */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024
/** Before the handshake is complete nothing long is accepted. */
export const MAX_HANDSHAKE_FRAME_BYTES = 4096
/** A connection that has not completed the handshake after this long is closed. */
export const HANDSHAKE_TIMEOUT_MS = 5000

const Nonce = z.string().regex(/^[0-9a-f]{64}$/)
const Proof = z.string().regex(/^[0-9a-f]{64}$/)
const RequestId = z.string().min(1).max(64)

export const CLIENT_KINDS = ['desktop', 'tool'] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]

/** What the runtime may ask the desktop to show. A closed set: the runtime never sends a path to open or text to run. */
export const UiRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('confirm'),
      level: z.enum(['question', 'warning']),
      title: z.string().max(200),
      message: z.string().max(2000),
      detail: z.string().max(8000),
      buttons: z.array(z.string().max(200)).min(1).max(4),
      defaultId: z.number().int().min(0).max(3),
      cancelId: z.number().int().min(0).max(3),
    })
    .strict(),
  z.object({ kind: z.literal('pickDirectory'), title: z.string().max(200) }).strict(),
  z.object({ kind: z.literal('openDataDir') }).strict(),
])
export type UiRequest = z.infer<typeof UiRequestSchema>

/** The desktop's answer: the index of the button, the chosen directory (null when cancelled), or nothing. */
export const UiResponseSchema = z.union([z.object({ response: z.number().int().min(0).max(3) }).strict(), z.object({ path: z.string().max(4096).nullable() }).strict(), z.object({ done: z.literal(true) }).strict()])
export type UiResponse = z.infer<typeof UiResponseSchema>

export const ClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocol: z.number().int(), client: z.enum(CLIENT_KINDS), nonce: Nonce }).strict(),
  z.object({ t: z.literal('auth'), proof: Proof }).strict(),
  z.object({ t: z.literal('req'), id: RequestId, channel: z.string().min(1).max(100), input: z.unknown().optional() }).strict(),
  z.object({ t: z.literal('ui.res'), id: RequestId, ok: z.boolean(), value: UiResponseSchema.optional(), error: z.string().max(2000).optional() }).strict(),
  z.object({ t: z.literal('ping') }).strict(),
])
export type ClientFrame = z.infer<typeof ClientFrameSchema>

export const RUNTIME_ERROR_CODES = ['protocol_mismatch', 'auth_failed', 'bad_frame', 'frame_too_long', 'handshake_timeout', 'shutting_down'] as const
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number]

export const ServerFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('challenge'), protocol: z.number().int(), nonce: Nonce, proof: Proof }).strict(),
  z.object({ t: z.literal('welcome'), protocol: z.number().int(), version: z.string().max(64), pid: z.number().int(), bootId: z.string().max(64), startedAt: z.string().max(64) }).strict(),
  z.object({ t: z.literal('res'), id: RequestId, result: z.unknown() }).strict(),
  z.object({ t: z.literal('push'), message: z.unknown() }).strict(),
  z.object({ t: z.literal('ui.req'), id: RequestId, request: UiRequestSchema }).strict(),
  z.object({ t: z.literal('error'), code: z.enum(RUNTIME_ERROR_CODES), message: z.string().max(2000) }).strict(),
  z.object({ t: z.literal('pong') }).strict(),
])
export type ServerFrame = z.infer<typeof ServerFrameSchema>

/** What the runtime says about itself in the handshake. */
export interface RuntimeIdentity {
  protocol: number
  version: string
  pid: number
  /** New on every start of the runtime; a client that sees it change knows the runtime restarted. */
  bootId: string
  startedAt: string
}

/** The file through which a client finds the runtime. It lives in the data directory, readable by the Windows user only. */
export const EndpointFileSchema = z
  .object({
    protocol: z.number().int(),
    version: z.string().max(64),
    pipe: z.string().min(1).max(512),
    /** 32 random bytes, hex. The shared secret of the handshake. */
    token: z.string().regex(/^[0-9a-f]{64}$/),
    pid: z.number().int(),
    bootId: z.string().max(64),
    startedAt: z.string().max(64),
  })
  .strict()
export type EndpointFile = z.infer<typeof EndpointFileSchema>

// ───────────────────────────── what the window is told ─────────────────────────────

/** The desktop's connection to the runtime, as the window shows it. */
export const CONNECTION_PHASES = ['STARTING_RUNTIME', 'CONNECTING', 'RECOVERING', 'READY', 'DISCONNECTED', 'INCOMPATIBLE'] as const
export type ConnectionPhase = (typeof CONNECTION_PHASES)[number]

export interface ConnectionState {
  phase: ConnectionPhase
  /** One sentence for the user. */
  detail: string
  /** The runtime this window is (or was last) connected to. */
  runtime: RuntimeIdentity | null
  /** Connection attempts since the connection was lost; 0 while connected. */
  attempt: number
  since: string
}

/** What the runtime reports about itself over `runtime.status`. */
export interface RuntimeStatus extends RuntimeIdentity {
  phase: 'RECOVERING' | 'READY' | 'STOPPING'
  /** While recovering: what is being reconciled. Kept afterwards as the record of the last start. */
  recovery: { workloads: number; workers: number; leases: number; finishedAt: string | null }
  clients: { desktop: number; tool: number }
  /** True while the user paused the start of new work from the tray or the Control Center. */
  dispatchPaused: boolean
  /** Whether the endpoint file's access list could be narrowed to the user. */
  endpointAcl: 'restricted' | 'inherited'
  /** The runtime stays while this is true; otherwise it stops by itself after a quiet period with no window. */
  keepAlive: { reason: string | null }
  /** What the runtime process uses now. Diagnostics; a soak run watches these for growth. */
  resources: { uptimeSeconds: number; rssMb: number; heapUsedMb: number; timers: number; handles: number; dbMb: number; walMb: number }
}
