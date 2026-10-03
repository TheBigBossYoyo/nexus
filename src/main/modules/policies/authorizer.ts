import path from 'node:path'
import type { AgentRole } from '@shared/domain'
import type { ToolDecision, ToolRequest } from '@main/modules/agent-runtime/types'
import { classifyCommand } from './command-classifier'
import type { SegmentKind } from './command-classifier'
import { canonicalizePath, isInsideGitDir, isPathInside, isSecretPath } from './paths'
import { isInspectionOnlyRole, isWritingRole, toolsForRole } from './tools'

export interface PolicyContext {
  role: AgentRole
  /** The directory the agent is confined to for writes. */
  worktreeRoot: string
  projectRoot: string
  extraReadRoots?: string[]
  /** Command word-prefixes (e.g. "pnpm test:unit") that reviewers/verifiers may run in addition to the built-in runners. */
  safeCommandPrefixes: string[]
  allowNetworkTools: boolean
  /** Exact `mcp__<server>__<tool>` names permitted besides the built-in `nexus` server. */
  allowedMcpTools?: string[]
  /** Whole MCP servers (the `<server>` part) permitted. */
  allowedMcpServers?: string[]
}

type Risk = 'low' | 'medium' | 'high'
const deny = (reason: string): ToolDecision => ({ behavior: 'deny', reason })
const ask = (reason: string, risk: Risk): ToolDecision => ({ behavior: 'ask', reason, risk })
const ALLOW: ToolDecision = { behavior: 'allow' }

const canon = canonicalizePath

function strField(input: Record<string, unknown>, key: string): string | null {
  const v = input[key]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'lan', 'intranet', 'corp', 'home', 'private']
const NUMERIC_LABEL = /^(0x[0-9a-f]*|\d+)$/i

/** inet_aton-style parse (1-4 parts; decimal, octal or hex). null when invalid. */
function parseIPv4(labels: string[]): number | null {
  if (labels.length < 1 || labels.length > 4) return null
  const vals: number[] = []
  for (const l of labels) {
    const hex = /^0x/i.test(l)
    const octal = !hex && l.length > 1 && l.startsWith('0')
    if (octal && /[89]/.test(l)) return null
    const v = hex ? (l.length === 2 ? 0 : Number.parseInt(l.slice(2), 16)) : Number.parseInt(l, octal ? 8 : 10)
    if (!Number.isSafeInteger(v) || v < 0) return null
    vals.push(v)
  }
  const last = vals[vals.length - 1] ?? 0
  const head = vals.slice(0, -1)
  if (head.some((v) => v > 255) || last >= 256 ** (5 - vals.length)) return null
  let n = last
  head.forEach((v, idx) => {
    n += v * 256 ** (3 - idx)
  })
  return n
}

function isPrivateIPv4(n: number): boolean {
  const a = Math.floor(n / 2 ** 24)
  const b = Math.floor(n / 2 ** 16) % 256
  const c = Math.floor(n / 2 ** 8) % 256
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

/** Eight 16-bit groups of an IPv6 literal, or null when malformed. */
function parseIPv6(host: string): number[] | null {
  let h = host
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(h)
  if (dotted?.[1] !== undefined) {
    const v4 = parseIPv4(dotted[1].split('.'))
    if (v4 === null) return null
    h = `${h.slice(0, -dotted[1].length)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`
  }
  const halves = h.split('::')
  if (halves.length > 2) return null
  const toGroups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(Number.parseInt(g, 16))
    }
    return out
  }
  const left = toGroups(halves[0] ?? '')
  const right = halves.length === 2 ? toGroups(halves[1] ?? '') : []
  if (left === null || right === null) return null
  if (halves.length === 1) return left.length === 8 ? left : null
  const fill = 8 - left.length - right.length
  if (fill < 1) return null
  return [...left, ...new Array<number>(fill).fill(0), ...right]
}

function isPrivateIPv6(g: number[]): boolean {
  const g0 = g[0] ?? 0
  const embedded = (hi: number, lo: number): number => hi * 65536 + lo
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true // :: and ::1
  if ((g0 & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true // link-local and site-local
  if (g0 === 0xff00 || (g0 & 0xff00) === 0xff00) return true // multicast
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateIPv4(embedded(g[6] ?? 0, g[7] ?? 0)) // mapped / compatible
  if (g0 === 0x64 && g[1] === 0xff9b) return isPrivateIPv4(embedded(g[6] ?? 0, g[7] ?? 0)) // NAT64
  if (g0 === 0x2002) return isPrivateIPv4(embedded(g[1] ?? 0, g[2] ?? 0)) // 6to4
  return false
}

/** True for loopback, private, link-local and otherwise non-public hosts, in any literal spelling. Fails closed. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (host === '') return true
  if (host.includes(':')) {
    const groups = parseIPv6(host)
    return groups === null || isPrivateIPv6(groups)
  }
  const labels = host.split('.')
  if (labels.every((l) => NUMERIC_LABEL.test(l))) {
    const n = parseIPv4(labels)
    return n === null || isPrivateIPv4(n)
  }
  if (labels.length === 1) return true // single-label intranet name
  const tld = labels[labels.length - 1] ?? ''
  return LOCAL_SUFFIXES.includes(tld)
}

/**
 * Builds the per-call policy check for one agent. Never throws: any internal failure is a deny.
 */
export function createAuthorizer(ctx: PolicyContext): (req: ToolRequest) => Promise<ToolDecision> {
  const tools = new Set(toolsForRole(ctx.role, { allowNetworkTools: ctx.allowNetworkTools }))
  const writing = isWritingRole(ctx.role)
  const toRoot = (r: string): string => {
    try {
      return canonicalizePath(r, r)
    } catch {
      return path.resolve(r)
    }
  }
  const worktree = toRoot(ctx.worktreeRoot)
  const project = toRoot(ctx.projectRoot)
  const readRoots = [worktree, project, ...(ctx.extraReadRoots ?? []).map(toRoot)]
  const shellRoots = writing ? [ctx.worktreeRoot] : [ctx.worktreeRoot, ctx.projectRoot, ...(ctx.extraReadRoots ?? [])]
  const inReadRoots = (c: string): boolean => readRoots.some((r) => isPathInside(r, c))

  function authorizeRead(raw: string | null, field: string, base: string = worktree): ToolDecision {
    if (raw === null) return deny(`${field} is required`)
    const target = canon(raw, base)
    if (!inReadRoots(target)) {
      return deny(`Read denied: ${raw} is outside the worktree, project and approved read locations. Use paths inside ${worktree}.`)
    }
    if (isSecretPath(target) || isSecretPath(raw)) return ask(`accessing secrets: ${raw} looks like a credential or secret file`, 'high')
    return ALLOW
  }

  function authorizeWrite(raw: string | null, field: string): ToolDecision {
    if (raw === null) return deny(`${field} is required`)
    const target = canon(raw, worktree)
    if (isPathInside(worktree, target)) {
      if (isInsideGitDir(worktree, target)) return deny(`Write denied: ${raw} is inside a .git directory, which agents must never modify.`)
      return ALLOW
    }
    if (isPathInside(project, target)) {
      return deny(
        `Write denied: ${raw} is in the project root but outside your task worktree. Edit the equivalent file under ${worktree} instead.`,
      )
    }
    return deny(
      `Write denied: ${raw} is outside the project and worktree. Files outside the task worktree cannot be modified (denied by default; no approval path).`,
    )
  }

  /** Glob patterns and grep globs can climb out of the search root with `..` or absolute prefixes. */
  function authorizePattern(pattern: string | null, base: string): ToolDecision {
    if (pattern === null) return ALLOW
    const segs = pattern.split(/[\\/]/)
    const escapes = segs.includes('..') || /^([a-zA-Z]:|[\\/]|~)/.test(pattern)
    if (!escapes) return ALLOW
    const glob = pattern.search(/[*?[{]/)
    const literal = glob >= 0 ? pattern.slice(0, glob) : pattern
    const dir = glob >= 0 ? literal.replace(/[^\\/]*$/, '') : literal
    if (dir.startsWith('~')) return deny(`Pattern denied: ${pattern} points at the home directory.`)
    const target = canon(dir === '' ? '.' : dir, base)
    if (!inReadRoots(target)) return deny(`Pattern denied: ${pattern} reaches outside the allowed read locations.`)
    return ALLOW
  }

  function authorizeShell(toolName: 'Bash' | 'PowerShell', input: Record<string, unknown>): ToolDecision {
    const command = strField(input, 'command')
    if (command === null) return deny('command is required')
    const cls = classifyCommand(command, toolName === 'Bash' ? 'bash' : 'powershell', {
      roots: shellRoots,
      safeCommandPrefixes: ctx.safeCommandPrefixes,
    })
    if (cls.level === 'forbidden') {
      return deny(`Command forbidden: ${cls.reasons.join('; ')}. This cannot be approved; choose a different approach.`)
    }

    const restricted = !writing
    if (restricted) {
      const allowedKinds: SegmentKind[] = isInspectionOnlyRole(ctx.role) ? ['readonly'] : ['readonly', 'verify', 'install']
      const bad = cls.segments.filter((s) => !allowedKinds.includes(s.kind))
      if (bad.length > 0) {
        const names = [...new Set(bad.map((s) => s.command || '(redirection)'))].join(', ')
        const hint = isInspectionOnlyRole(ctx.role)
          ? 'Only read-only inspection commands (git status/log/diff/show, ls/dir, cat/type, rg/grep/findstr, pwd, version probes) without output redirection are allowed.'
          : 'Only read-only inspection and test/build/lint/typecheck commands without output redirection are allowed.'
        return deny(`Command not permitted for the ${ctx.role} role (${names}). ${hint}`)
      }
    }

    const reasons = [...cls.reasons]
    let risk: Risk | null = cls.risk
    if (input.dangerouslyDisableSandbox === true) {
      reasons.push('requests to run outside the tool sandbox')
      risk = 'high'
    }
    if (reasons.length > 0) return ask(reasons.join('; '), risk ?? 'medium')
    if (restricted && cls.segments.some((s) => s.kind === 'install')) {
      return ask('installs project dependencies into the worktree', 'low')
    }
    return ALLOW
  }

  function decide(req: ToolRequest): ToolDecision {
    const { toolName, input } = req
    if (toolName.startsWith('mcp__')) {
      if (toolName.startsWith('mcp__nexus__')) return ALLOW
      const server = toolName.split('__')[1] ?? ''
      if (ctx.allowedMcpTools?.includes(toolName) || ctx.allowedMcpServers?.includes(server)) return ALLOW
      return deny(`MCP tool ${toolName} is not on the allowed list for this project.`)
    }
    if (toolName === 'Agent' || toolName === 'Task') {
      return deny('Sub-agents are not available; NEXUS orchestrates agents. Use the nexus tools to message the team instead.')
    }
    if (!tools.has(toolName)) {
      return deny(`Tool ${toolName} is not available to the ${ctx.role} role. Available tools: ${[...tools].join(', ')}.`)
    }
    switch (toolName) {
      case 'Read':
        return authorizeRead(strField(input, 'file_path'), 'file_path')
      case 'Edit':
      case 'Write':
        return authorizeWrite(strField(input, 'file_path'), 'file_path')
      case 'NotebookEdit':
        return authorizeWrite(strField(input, 'notebook_path'), 'notebook_path')
      case 'Glob':
      case 'Grep': {
        const rawBase = strField(input, 'path')
        const dirDecision = rawBase === null ? ALLOW : authorizeRead(rawBase, 'path')
        if (dirDecision.behavior !== 'allow') return dirDecision
        const base = rawBase === null ? worktree : canon(rawBase, worktree)
        return authorizePattern(strField(input, toolName === 'Glob' ? 'pattern' : 'glob'), base)
      }
      case 'Bash':
      case 'PowerShell':
        return authorizeShell(toolName, input)
      case 'TodoWrite':
        return ALLOW
      case 'WebSearch':
        return strField(input, 'query') === null ? deny('query is required') : ALLOW
      case 'WebFetch': {
        const raw = strField(input, 'url')
        if (raw === null) return deny('url is required')
        let url: URL
        try {
          url = new URL(raw)
        } catch {
          return deny(`Invalid URL: ${raw}`)
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return deny(`Only http(s) URLs may be fetched, not ${url.protocol}`)
        if (isPrivateHost(url.hostname)) return ask(`fetches a local or private-network address: ${url.hostname}`, 'medium')
        return ALLOW
      }
      default:
        return deny(`Tool ${toolName} has no policy and is denied by default.`)
    }
  }

  return async (req: ToolRequest): Promise<ToolDecision> => {
    try {
      return decide(req)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return deny(`Denied: the request could not be evaluated safely (${msg}).`)
    }
  }
}
