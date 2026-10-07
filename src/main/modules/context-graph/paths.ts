import { createHash } from 'node:crypto'
import { NexusError } from '@shared/result'

/** Deepest path a node may have. The fixed hierarchy uses five levels; notes may nest a little further. */
export const MAX_PATH_DEPTH = 10
export const MAX_PATH_CHARS = 400
export const MAX_SEGMENT_CHARS = 80

const SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/

export function shortHash(text: string, length = 8): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length)
}

export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * One path segment for arbitrary text: lowercase, `/` and `\` become `.`, anything else outside
 * `[a-z0-9._~-]` becomes `-`. Text that leaves nothing usable, or is too long, gets a hash so two
 * different inputs never silently share a segment.
 */
export function segment(text: string): string {
  const lowered = text.trim().toLowerCase().replace(/[\\/]+/g, '.')
  let s = lowered
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._~]+|[-._~]+$/g, '')
  if (s === '') return `x-${shortHash(text)}`
  if (s.length > MAX_SEGMENT_CHARS) s = `${s.slice(0, MAX_SEGMENT_CHARS - 9).replace(/[-._~]+$/, '')}-${shortHash(text)}`
  return s
}

export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/')
}

export function parentPath(path: string): string | null {
  if (path === '') return null
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function depthOf(path: string): number {
  return path === '' ? 0 : path.split('/').length
}

/**
 * A path as given by an agent or the renderer. Refuses anything that is not a plain canonical path: no
 * traversal, no empty segment, no encoded separator, no control character. Returns the canonical form.
 */
export function validatePath(input: string): string {
  if (typeof input !== 'string') throw new NexusError('invalid_input', 'A context path must be text')
  const raw = input.trim().replace(/^\/+|\/+$/g, '')
  if (raw === '') return ''
  if (raw.length > MAX_PATH_CHARS) throw new NexusError('invalid_input', `A context path is at most ${MAX_PATH_CHARS} characters`)
  if (/[\0-\x1f\x7f\\%]/.test(raw)) throw new NexusError('invalid_input', 'A context path holds only lowercase letters, digits, ".", "_", "~", "-" and "/"')
  const parts = raw.split('/')
  if (parts.length > MAX_PATH_DEPTH) throw new NexusError('invalid_input', `A context path is at most ${MAX_PATH_DEPTH} levels deep`)
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || p.includes('..') || !SEGMENT.test(p)) throw new NexusError('invalid_input', `Invalid context path segment: ${JSON.stringify(p.slice(0, 40))}`)
    if (p.length > MAX_SEGMENT_CHARS) throw new NexusError('invalid_input', `A context path segment is at most ${MAX_SEGMENT_CHARS} characters`)
  }
  return parts.join('/')
}

/** What a statement is about, normalized so that the same subject written twice compares equal. */
export function subjectKey(kind: string, subject: string): string {
  const s = subject.trim().toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').replace(/[.:;,!?]+$/, '')
  return `${kind}:${s.length > 160 ? `${s.slice(0, 120)}#${shortHash(s)}` : s}`
}

/** Repository-relative path in the form facts and tasks use. */
export function normFile(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}
