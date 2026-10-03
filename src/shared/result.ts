export type Result<T, E = NexusError> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export type ErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'invalid_state'
  | 'invalid_transition'
  | 'dirty_repository'
  | 'not_a_repository'
  | 'git_failed'
  | 'git_conflict'
  | 'path_violation'
  | 'auth_required'
  | 'api_key_blocked'
  | 'runtime_unavailable'
  | 'database'
  | 'internal'

/** Error with a stable machine-readable code. Thrown inside main; mapped to IpcResult at the boundary. */
export class NexusError extends Error {
  readonly code: ErrorCode
  readonly detail: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'NexusError'
    this.code = code
    this.detail = detail
  }
}

export function assertNever(value: never, context = 'value'): never {
  throw new NexusError('internal', `Unexpected ${context}: ${JSON.stringify(value)}`)
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
