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

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|.*\.localhost|\[?::1\]?|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|0\.0\.0\.0)$/i

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
        if (PRIVATE_HOST.test(url.hostname)) return ask(`fetches a local or private-network address: ${url.hostname}`, 'medium')
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
