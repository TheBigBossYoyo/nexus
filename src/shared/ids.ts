/** Stable unique id. `crypto.randomUUID` is a global in both Node 24 and the renderer. */
export function newId(): string {
  return globalThis.crypto.randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** Short, filesystem- and branch-safe slug derived from an id (first 8 hex chars). */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8)
}
