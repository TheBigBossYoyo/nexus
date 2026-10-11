import { createHash } from 'node:crypto'
import path from 'node:path'
import { MAX_RESOURCE_CHARS, type AutonomyCapability, type CapabilityResource } from '@shared/autonomy'

const WINDOWS = process.platform === 'win32'

/** A path as it is compared: absolute, separators and case as Windows compares them, no trailing separator. */
function normalizePath(value: string): string {
  const resolved = path.resolve(value)
  const trimmed = resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved
  return WINDOWS ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed
}

/** `host` or `host:port`, lower case, no trailing dot, IDN in its ASCII form. Empty when it is not a host. */
function normalizeHost(value: string): string {
  const raw = value.trim().toLowerCase()
  if (raw === '') return ''
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`)
    const host = url.hostname.replace(/\.+$/, '')
    return url.port !== '' ? `${host}:${url.port}` : host
  } catch {
    return ''
  }
}

/**
 * The form in which a resource is stored and compared. A value that cannot be normalized becomes the empty
 * string, which no grant covers and which never equals `ANY`.
 */
export function normalizeResource(resource: CapabilityResource): CapabilityResource {
  const value = resource.value.slice(0, MAX_RESOURCE_CHARS)
  switch (resource.kind) {
    case 'ANY':
      return { kind: 'ANY', value: '' }
    case 'PATH':
      return { kind: 'PATH', value: value.trim() === '' ? '' : normalizePath(value) }
    case 'HOST':
      return { kind: 'HOST', value: normalizeHost(value) }
    case 'GIT_REMOTE':
    case 'PACKAGE':
    case 'ENDPOINT':
      return { kind: resource.kind, value: value.trim().toLowerCase() }
    case 'COMMAND':
    case 'ACCOUNT':
      return { kind: resource.kind, value: value.trim().replace(/\s+/g, ' ') }
  }
}

function pathCovers(root: string, target: string): boolean {
  if (root === '' || target === '') return false
  if (root === target) return true
  const sep = WINDOWS ? '\\' : '/'
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function hostCovers(granted: string, target: string): boolean {
  if (granted === '' || target === '') return false
  if (granted === target) return true
  // A grant that names no port covers every port of that host. It never covers a subdomain.
  return !granted.includes(':') && target.startsWith(`${granted}:`)
}

/**
 * Whether a grant for `granted` covers a need for `needed`. Both must be normalized. `ANY` covers everything of
 * its capability; a named resource covers itself (and, for a path, what lies under it) and never `ANY`.
 */
export function resourceCovers(granted: CapabilityResource, needed: CapabilityResource): boolean {
  if (granted.kind === 'ANY') return true
  if (needed.kind === 'ANY' || granted.kind !== needed.kind) return false
  if (granted.kind === 'PATH') return pathCovers(granted.value, needed.value)
  if (granted.kind === 'HOST') return hostCovers(granted.value, needed.value)
  return granted.value !== '' && granted.value === needed.value
}

/** One key per distinct need inside a mission: the same key is the same question to the user. */
export function boundaryDedupeKey(input: { projectId: string; runId: string | null; capability: AutonomyCapability; resource: CapabilityResource }): string {
  const r = normalizeResource(input.resource)
  return createHash('sha256').update(JSON.stringify([input.projectId, input.runId ?? '', input.capability, r.kind, r.value])).digest('hex').slice(0, 40)
}

export function describeResource(resource: CapabilityResource): string {
  return resource.kind === 'ANY' ? 'any' : `${resource.kind.toLowerCase().replace('_', ' ')}: ${resource.value}`
}
