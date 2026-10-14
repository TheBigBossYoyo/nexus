import { PUSH_FORM_HINT, grantedPushOf, renderUserGitScript, userGitOf, userGitOfPowerShell, type UserGitInvocation } from './git-pipeline'
import { lookup as dnsLookup } from 'node:dns/promises'
import path from 'node:path'
import type { AgentRole } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { SECURITY_POLICY_VERSION, type ExecutionDecision, type ExecutionProfile, type ProvenanceKind, type TrustClass } from '@shared/security'
import type { ToolDecision, ToolRequest } from '@main/modules/agent-runtime/types'
import type { AutonomyGate } from '@main/modules/autonomy/gate'
import type { ShellContainment } from '@main/modules/isolation/session-containment'
import { needForExecutionReason, needsForFindings, type CapabilityNeed } from '@main/modules/autonomy/tool-capabilities'
import { classifyAddress } from '@main/modules/network/address'
import { screenOutboundUrl } from '@main/modules/network/exfiltration'
import { capabilitiesForRole } from './capabilities'
import { classifyCommand } from './command-classifier'
import type { SegmentKind } from './command-classifier'
import { collectWriteTargets, evaluateExecution, type ExecutionEnv } from './execution-policy'
import { canonicalizePath, isInsideGitDir, isPathInside, isSecretPath } from './paths'
import type { BaseFileReader, ProvenanceTracker } from './provenance'
import { NEXUS_DATA_TEXT } from './power-patterns'
import { actionSummary, type SecurityDecisionSink } from './security-log'
import { tokenize } from './shell-tokenizer'
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
  /** How a host name is resolved before a native fetch is allowed without a question. Tests replace it. */
  resolveHost?: (host: string) => Promise<string[]>
  /** Exact `mcp__<server>__<tool>` names permitted besides the built-in `nexus` server. */
  allowedMcpTools?: string[]
  /** Whole MCP servers (the `<server>` part) permitted. */
  allowedMcpServers?: string[]
  /** 0.7 execution security: profile, provenance, the base commit reader and the decision log. All optional. */
  execution?: ExecutionContext
  /**
   * 0.8: present for a project the user enrolled. Where the policy would ask the user, or refuse something a
   * grant could cover, the capability broker decides instead: the call is allowed or refused, never put to the
   * user as an approval. Absent, the approvals of 0.7 apply unchanged.
   */
  autonomy?: AutonomyGate
  /**
   * 0.8: how this session's shell commands run. With a profile other than STANDARD, a command that was allowed
   * is handed to the shell tool as its launch inside the containment; when the containment cannot be made the
   * command is refused. Absent: commands run as written, as before 0.8.
   */
  containment?: ShellContainment
}

export interface ExecutionContext {
  /** Default STANDARD. Neither profile is an operating-system sandbox. */
  profile?: ExecutionProfile
  /** Shared across the authorizers of one process so that a file one agent wrote is known to the next one. */
  provenance?: ProvenanceTracker
  /** Reads files as they are in the worktree's base commit; without it only recorded writes identify agent-authored files. */
  base?: BaseFileReader
  /** Receives every deny, approval-required and audited decision. */
  decisions?: SecurityDecisionSink
  runId?: string | null
  taskId?: string | null
}

/** Why a call was decided the way it was, for the decision log. Plain allows carry none. */
interface AuditInfo {
  classification: TrustClass
  provenance: ProvenanceKind
  decision: ExecutionDecision
  reason: string
}
interface Outcome {
  tool: ToolDecision
  audit?: AuditInfo
  /** 0.8: what the call needs of the capability broker. Read only when the project is enrolled. */
  needs?: CapabilityNeed[]
  /** 0.8: set for a shell call: whether the command is git and nothing else, with no finding. */
  shell?: { kind: 'bash' | 'powershell'; command: string; gitOnly: boolean; gitScript?: string; grantedPush?: UserGitInvocation[] }
}

/** A decision of the file tools with the capability a grant would have to cover, when there is one. */
type Decided = ToolDecision & { need?: CapabilityNeed; /** A host that must resolve to public addresses only for the decision to stand. */ resolveHost?: string }
const needing = (decision: ToolDecision, capability: CapabilityNeed['capability'], why: string, pathValue?: string): Decided => ({
  ...decision,
  need: { capability, why, inBoundary: false, resource: pathValue === undefined ? { kind: 'ANY', value: '' } : { kind: 'PATH', value: pathValue } },
})

type Risk = 'low' | 'medium' | 'high'
const NEXUS_DATA_DENY = "Denied: NEXUS's own database, key files and runtime endpoint (named pipe, endpoint.json, runtime.log) are not available to agents."
const deny = (reason: string): ToolDecision => ({ behavior: 'deny', reason })
const ask = (reason: string, risk: Risk): ToolDecision => ({ behavior: 'ask', reason, risk })
const ALLOW: ToolDecision = { behavior: 'allow' }
const ENROLLED_WEB = 'In this project the web is read with research_search and research_read, not with WebSearch or WebFetch.'
const resolvePublicly = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true })).map((entry) => entry.address)

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
  const profile: ExecutionProfile = ctx.execution?.profile ?? 'STANDARD'
  const restrictedProfile = profile === 'RESTRICTED'
  const caps = capabilitiesForRole(ctx.role, { allowNetworkTools: ctx.allowNetworkTools, profile })
  const toRoot = (r: string): string => {
    try {
      return canonicalizePath(r, r)
    } catch {
      return path.resolve(r)
    }
  }
  const worktree = toRoot(ctx.worktreeRoot)
  const project = toRoot(ctx.projectRoot)
  // RESTRICTED keeps reads to the worktree (and read roots the user added); the project root is left out.
  const readRoots = restrictedProfile ? [worktree, ...(ctx.extraReadRoots ?? []).map(toRoot)] : [worktree, project, ...(ctx.extraReadRoots ?? []).map(toRoot)]
  const shellRoots = writing ? [ctx.worktreeRoot] : restrictedProfile ? [ctx.worktreeRoot, ...(ctx.extraReadRoots ?? [])] : [ctx.worktreeRoot, ctx.projectRoot, ...(ctx.extraReadRoots ?? [])]
  const safePrefixes = ctx.safeCommandPrefixes.map((p) => p.trim().toLowerCase().split(/\s+/).filter(Boolean)).filter((p) => p.length > 0)
  const inReadRoots = (c: string): boolean => readRoots.some((r) => isPathInside(r, c))

  function authorizeRead(raw: string | null, field: string, base: string = worktree): Decided {
    if (raw === null) return deny(`${field} is required`)
    const target = canon(raw, base)
    if (NEXUS_DATA_TEXT.test(raw) || NEXUS_DATA_TEXT.test(target)) return needing(deny(NEXUS_DATA_DENY), 'ACCESS_NEXUS_CONTROL_PLANE', 'names NEXUS application data', target)
    if (!inReadRoots(target)) {
      return needing(deny(`Read denied: ${raw} is outside the worktree, project and approved read locations. Use paths inside ${worktree}.`), 'READ_OUTSIDE_PROJECT', 'reads a file outside the enrolled project', target)
    }
    if (isSecretPath(target) || isSecretPath(raw)) return needing(ask(`accessing secrets: ${raw} looks like a credential or secret file`, 'high'), 'READ_PROJECT_SECRETS', 'reads a file that looks like a credential or secret', target)
    return ALLOW
  }

  function authorizeWrite(raw: string | null, field: string, agentId: string, content?: string): Decided {
    if (raw === null) return deny(`${field} is required`)
    const target = canon(raw, worktree)
    if (NEXUS_DATA_TEXT.test(raw) || NEXUS_DATA_TEXT.test(target)) return needing(deny(NEXUS_DATA_DENY), 'ACCESS_NEXUS_CONTROL_PLANE', 'names NEXUS application data', target)
    if (isPathInside(worktree, target)) {
      if (isInsideGitDir(worktree, target)) return deny(`Write denied: ${raw} is inside a .git directory, which agents must never modify.`)
      // Remember who wrote it: running this file later is judged as agent-authored code.
      ctx.execution?.provenance?.recordWrite(target, worktree, { agentId, taskId: ctx.execution.taskId ?? null, runId: ctx.execution.runId ?? null }, content)
      return ALLOW
    }
    if (isPathInside(project, target)) {
      return deny(
        `Write denied: ${raw} is in the project root but outside your task worktree. Edit the equivalent file under ${worktree} instead.`,
      )
    }
    return needing(
      deny(`Write denied: ${raw} is outside the project and worktree. Files outside the task worktree cannot be modified (denied by default; no approval path).`),
      'WRITE_OUTSIDE_PROJECT',
      'writes a file outside the task worktree',
      target,
    )
  }

  /** Glob patterns and grep globs can climb out of the search root with `..` or absolute prefixes. */
  function authorizePattern(pattern: string | null, base: string): ToolDecision {
    if (pattern === null) return ALLOW
    if (NEXUS_DATA_TEXT.test(pattern)) return deny(NEXUS_DATA_DENY)
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

  async function authorizeShell(toolName: 'Bash' | 'PowerShell', input: Record<string, unknown>, agentId: string): Promise<Outcome> {
    const command = strField(input, 'command')
    if (command === null) return { tool: deny('command is required') }
    const shell = toolName === 'Bash' ? 'bash' : 'powershell'
    const cls = classifyCommand(command, shell, {
      roots: shellRoots,
      safeCommandPrefixes: ctx.safeCommandPrefixes,
      projectRoot: project,
    })
    if (cls.level === 'forbidden') {
      const reason = `Command forbidden: ${cls.reasons.join('; ')}. This cannot be approved; choose a different approach.`
      return { tool: deny(reason), audit: { classification: 'SYSTEM_SENSITIVE', provenance: 'not_applicable', decision: 'DENY', reason }, needs: forbiddenNeeds(cls.reasons) }
    }
    const base = authorizeShellByClass(input, cls)
    if (base.behavior === 'deny') {
      return { tool: base, audit: { classification: 'UNTRUSTED_AGENT_AUTHORED', provenance: 'not_applicable', decision: 'DENY', reason: base.reason } }
    }

    // 0.7: look through interpreters, scripts and package scripts at what will really run.
    const env: ExecutionEnv = {
      role: ctx.role,
      caps,
      profile,
      worktree,
      projectRoot: project,
      safeCommandPrefixes: safePrefixes,
      tracker: ctx.execution?.provenance,
      base: ctx.execution?.base,
    }
    const verdict = await evaluateExecution(command, shell, env)
    const networkDenied =
      restrictedProfile && !caps.has('NETWORK') && cls.classes.includes('NETWORK')
        ? 'network access is not allowed in the RESTRICTED execution profile unless network tools are enabled in Settings'
        : null
    if (verdict.decision === 'DENY' || networkDenied !== null) {
      const reason = [...(networkDenied !== null ? [networkDenied] : []), ...(verdict.decision === 'DENY' ? verdict.reasons : [])].join('; ')
      return {
        tool: deny(`Execution denied: ${reason}. This cannot be approved; choose a different approach.`),
        audit: { classification: verdict.decision === 'DENY' ? verdict.trust : 'SYSTEM_SENSITIVE', provenance: verdict.provenance, decision: 'DENY', reason },
      }
    }
    // The command will run or be put to the user: remember the files it writes so later runs know who wrote them.
    recordShellWrites(command, shell, agentId)

    const contained = ctx.autonomy?.contained === true
    const confined = ctx.autonomy?.confined === true
    const baseNeed = shellBaseNeed(cls)
    // git alone, or git with nothing but text filters around it: such a command runs where the repository is readable.
    // Decided by its own strict reading of the command, never by the absence of findings alone: what qualifies
    // runs as the user.
    const userGit = cls.findings.length === 0 ? (shell === 'bash' ? userGitOf(command) : userGitOfPowerShell(command)) : null
    const gitOnly = userGit !== null
    // What runs for such a command is a bash script NEXUS writes from the parsed invocations, never the command's
    // text, and whichever shell the command was written for.
    const shellInfo = { kind: shell, command, gitOnly, ...(userGit !== null ? { gitScript: renderUserGitScript(userGit) } : {}) } as const
    if (base.behavior === 'ask' || verdict.decision === 'REQUIRE_APPROVAL') {
      const findings = [
        ...cls.findings,
        ...(input.dangerouslyDisableSandbox === true ? [{ reason: 'requests to run outside the tool sandbox', cls: 'UNKNOWN' as const }] : []),
        ...(base.behavior === 'ask' && cls.findings.length === 0 && input.dangerouslyDisableSandbox !== true ? [{ reason: base.reason, cls: 'UNKNOWN' as const }] : []),
      ]
      const needs = [
        baseNeed,
        ...needsForFindings(findings, { contained, confined, localPorts: ctx.autonomy?.localPorts() ?? [] }),
        ...(verdict.decision === 'REQUIRE_APPROVAL' ? verdict.reasons.map((r) => needForExecutionReason(r, verdict.trust, { contained, confined })) : []),
      ]
      const reasons = [...(base.behavior === 'ask' ? [base.reason] : []), ...(verdict.decision === 'REQUIRE_APPROVAL' ? verdict.reasons : [])]
      const reason = [...new Set(reasons)].join('; ')
      const baseRisk: Risk = base.behavior === 'ask' ? base.risk : 'low'
      const risk: Risk = baseRisk === 'high' || (verdict.decision === 'REQUIRE_APPROVAL' && verdict.trust === 'SYSTEM_SENSITIVE') ? 'high' : verdict.decision === 'REQUIRE_APPROVAL' ? 'medium' : baseRisk
      const classification: TrustClass =
        verdict.decision === 'REQUIRE_APPROVAL' ? verdict.trust : cls.commandClass === 'SYSTEM_CHANGE' || cls.commandClass === 'DESTRUCTIVE' ? 'SYSTEM_SENSITIVE' : 'UNTRUSTED_AGENT_AUTHORED'
      // A push, and nothing else that needs a decision: if the user's grant lets it run, the push runs as the script
      // NEXUS writes, as the user, and the git around it as git as the user. In an enrolled project whose commands
      // are contained, a push in any other form could never run, so it is refused here, with what to write, and no
      // question is put to the user for it.
      const onlyPush = needs.some((need) => need.capability === 'GIT_PUSH') && needs.every((need) => need.capability === 'GIT_PUSH' || need.inBoundary)
      const push = onlyPush ? grantedPushOf(command, shell) : null
      if (onlyPush && push === null && ctx.autonomy !== undefined && ctx.containment !== undefined && ctx.containment.profile !== 'STANDARD') {
        const text = `Not run: ${PUSH_FORM_HINT}`
        return { tool: deny(text), audit: { classification: 'UNTRUSTED_AGENT_AUTHORED', provenance: verdict.provenance, decision: 'DENY', reason: text } }
      }
      return { tool: ask(reason, risk), audit: { classification, provenance: verdict.provenance, decision: 'REQUIRE_APPROVAL', reason }, needs, shell: { kind: shell, command, gitOnly: false, ...(push !== null ? { grantedPush: push } : {}) } }
    }
    if (verdict.decision === 'ALLOW_WITH_AUDIT') {
      return { tool: ALLOW, audit: { classification: verdict.trust, provenance: verdict.provenance, decision: 'ALLOW_WITH_AUDIT', reason: verdict.reasons.join('; ') }, needs: [baseNeed], shell: { kind: shell, command, gitOnly: false } }
    }
    return { tool: base, needs: [baseNeed], shell: shellInfo }
  }

  /** The profile capability a shell command is an exercise of, from what its parts are. */
  function shellBaseNeed(cls: ReturnType<typeof classifyCommand>): CapabilityNeed {
    const kinds = new Set(cls.segments.map((s) => s.kind))
    const capability: CapabilityNeed['capability'] = kinds.has('install')
      ? 'INSTALL_PROJECT_DEPENDENCIES'
      : kinds.has('other')
        ? cls.segments.every((s) => s.kind !== 'other' || s.class === 'GIT_LOCAL')
          ? 'GIT_LOCAL'
          : 'RUN_PROJECT_COMMAND'
        : kinds.has('verify')
          ? 'RUN_TESTS'
          : 'READ_PROJECT'
    return { capability, resource: { kind: 'ANY', value: '' }, why: 'runs a command in the task roots', inBoundary: true }
  }

  /** A forbidden command is refused whatever the broker says; these needs only make the broker record what was tried. */
  function forbiddenNeeds(reasons: string[]): CapabilityNeed[] {
    const text = reasons.join('; ')
    const capability: CapabilityNeed['capability'] | null = /credential stores/i.test(text)
      ? 'ACCESS_PROVIDER_SECRETS'
      : /NEXUS application data/i.test(text)
        ? 'ACCESS_NEXUS_CONTROL_PLANE'
        : /security tooling/i.test(text)
          ? 'DISABLE_SECURITY_SOFTWARE'
          : /shutting down|powering off/i.test(text)
            ? 'HOST_POWER'
            : null
    return capability === null ? [] : [{ capability, resource: { kind: 'ANY', value: '' }, why: text.slice(0, 300), inBoundary: false }]
  }

  function recordShellWrites(command: string, shell: 'bash' | 'powershell', agentId: string): void {
    const tracker = ctx.execution?.provenance
    if (tracker === undefined) return
    try {
      for (const target of collectWriteTargets(tokenize(command, shell))) {
        let inside = false
        try {
          inside = isPathInside(worktree, canon(target, worktree))
        } catch {
          inside = false
        }
        if (inside) tracker.recordWrite(target, worktree, { agentId, taskId: ctx.execution?.taskId ?? null, runId: ctx.execution?.runId ?? null })
      }
    } catch {
      // Provenance is best effort; the difference from the base commit still identifies the file.
    }
  }

  /** The command-classifier part of the shell policy (0.6 behaviour, unchanged). */
  function authorizeShellByClass(input: Record<string, unknown>, cls: ReturnType<typeof classifyCommand>): ToolDecision {

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
    if (cls.segments.some((s) => s.kind === 'install')) {
      if (restricted) return ask('installs project dependencies into the worktree', 'low')
      // RESTRICTED: installing fetches code and runs dependency lifecycle scripts, so it is never silent.
      if (restrictedProfile) return ask('installs project dependencies (network access and dependency scripts) in the RESTRICTED execution profile', 'medium')
    }
    return ALLOW
  }

  async function decide(req: ToolRequest): Promise<Outcome> {
    const { toolName, input } = req
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      if (!tools.has(toolName)) return { tool: deny(`Tool ${toolName} is not available to the ${ctx.role} role. Available tools: ${[...tools].join(', ')}.`) }
      return authorizeShell(toolName, input, req.agentId)
    }
    const { need, resolveHost, ...tool } = decideOther(req)
    if (resolveHost !== undefined && tool.behavior === 'allow') {
      const addresses = await (ctx.resolveHost ?? resolvePublicly)(resolveHost).catch(() => [] as string[])
      const classes = addresses.map((address) => classifyAddress(address))
      if (addresses.length === 0) return { tool: deny(`${resolveHost} did not resolve to an address.`) }
      if (classes.some((c) => c !== 'PUBLIC')) return { tool: ask(`fetches ${resolveHost}, a name that resolves to a local or private address`, 'medium') }
    }
    return { tool: tool as ToolDecision, ...(need !== undefined ? { needs: [need] } : {}) }
  }

  function decideOther(req: ToolRequest): Decided {
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
        return authorizeWrite(strField(input, 'file_path'), 'file_path', req.agentId, toolName === 'Write' && typeof input.content === 'string' ? input.content : undefined)
      case 'NotebookEdit':
        return authorizeWrite(strField(input, 'notebook_path'), 'notebook_path', req.agentId)
      case 'Glob':
      case 'Grep': {
        const rawBase = strField(input, 'path')
        const dirDecision = rawBase === null ? ALLOW : authorizeRead(rawBase, 'path')
        if (dirDecision.behavior !== 'allow') return dirDecision
        const base = rawBase === null ? worktree : canon(rawBase, worktree)
        return authorizePattern(strField(input, toolName === 'Glob' ? 'pattern' : 'glob'), base)
      }
      case 'TodoWrite':
        return ALLOW
      case 'WebSearch':
        if (ctx.autonomy !== undefined) return deny(ENROLLED_WEB)
        return strField(input, 'query') === null ? deny('query is required') : ALLOW
      case 'WebFetch': {
        // 0.9 (review, K-2): in an enrolled project the web is read through NEXUS's research tools, which the
        // capability broker decides and which resolve, pin, budget and record. This tool does none of that.
        if (ctx.autonomy !== undefined) return deny(ENROLLED_WEB)
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
        // 0.9 (review, K-1, K-2): a URL that is data is not fetched, by this tool either.
        const outbound = screenOutboundUrl(raw)
        if (!outbound.allowed) return deny(outbound.reason)
        // A public name can answer with a local address (`localtest.me`). The provider's tool is not NEXUS's
        // fetch and pins nothing, so a name is fetched without a question only when it resolves, here and now,
        // to public addresses alone; anything else is the user's to decide.
        return { ...ALLOW, resolveHost: url.hostname }
      }
      default:
        return deny(`Tool ${toolName} has no policy and is denied by default.`)
    }
  }

  const SENSITIVE = /\.git\b|secret|credential|power|registry|nexus/i

  /** Persists deny, approval-required and audited decisions; a plain allow is not stored. Never throws. */
  function log(req: ToolRequest, outcome: Outcome): void {
    const sink = ctx.execution?.decisions
    if (sink === undefined) return
    try {
      let audit = outcome.audit
      if (audit === undefined) {
        if (outcome.tool.behavior === 'allow') return
        const reason = outcome.tool.reason
        audit = {
          classification: SENSITIVE.test(reason) ? 'SYSTEM_SENSITIVE' : 'UNTRUSTED_AGENT_AUTHORED',
          provenance: 'not_applicable',
          decision: outcome.tool.behavior === 'deny' ? 'DENY' : 'REQUIRE_APPROVAL',
          reason,
        }
      }
      sink.record({
        id: newId(),
        timestamp: nowIso(),
        runId: ctx.execution?.runId ?? null,
        taskId: ctx.execution?.taskId ?? null,
        agentId: req.agentId,
        action: actionSummary(req.toolName, req.input),
        classification: audit.classification,
        provenance: audit.provenance,
        decision: audit.decision,
        reason: audit.reason.slice(0, 600),
        policyVersion: SECURITY_POLICY_VERSION,
      })
    } catch {
      // The log is evidence, not a gate: a failure to write it must not change the decision.
    }
  }

  /**
   * 0.8, enrolled projects only. A call with needs is decided by the capability broker: an `ask` never reaches
   * the user as an approval, and a refusal that a grant could cover becomes a boundary request. A call the
   * policy forbids outright stays forbidden; the broker is only told, so that the attempt is on record.
   */
  function throughBroker(req: ToolRequest, outcome: Outcome): Outcome {
    const gate = ctx.autonomy
    if (gate === undefined) return outcome
    const needs = outcome.needs ?? []
    const forbidden = outcome.tool.behavior === 'deny' && outcome.audit?.decision === 'DENY'
    if (needs.length === 0) {
      // An `ask` with nothing the broker could decide is refused: an enrolled project has no approval dialog.
      if (outcome.tool.behavior === 'ask') {
        const reason = `Denied: ${outcome.tool.reason}. This project works without approval dialogs; choose a different approach.`
        return { tool: deny(reason), audit: { classification: outcome.audit?.classification ?? 'UNTRUSTED_AGENT_AUTHORED', provenance: outcome.audit?.provenance ?? 'not_applicable', decision: 'DENY', reason } }
      }
      return outcome
    }
    const decided = gate.resolve(req, actionSummary(req.toolName, req.input), needs, outcome.audit?.classification)
    if (forbidden) return outcome
    if (decided.behavior === 'allow') {
      // What the policy only wanted to ask about, and the broker authorized, runs. The entry of the inspection
      // is kept as an audited allow, so the decision log still shows what was looked at.
      const audit: AuditInfo | undefined =
        outcome.audit?.decision === 'REQUIRE_APPROVAL' ? { ...outcome.audit, decision: 'ALLOW_WITH_AUDIT' } : outcome.audit?.decision === 'ALLOW_WITH_AUDIT' ? outcome.audit : undefined
      return { tool: ALLOW, ...(audit !== undefined ? { audit } : {}), ...(outcome.shell ? { shell: outcome.shell } : {}) }
    }
    const reason = decided.behavior === 'deny' ? decided.reason : 'Denied.'
    // A call that waits for the user's decision is logged as that, not as a refusal of the policy.
    const waits = decided.behavior === 'deny' && (decided.boundaryRequests?.length ?? 0) > 0
    return { tool: decided.behavior === 'deny' ? decided : deny(reason), audit: { classification: outcome.audit?.classification ?? 'UNTRUSTED_AGENT_AUTHORED', provenance: outcome.audit?.provenance ?? 'not_applicable', decision: waits ? 'REQUIRE_APPROVAL' : 'DENY', reason } }
  }

  /**
   * 0.8. A shell command that may run does not run as written when the session is contained: the shell tool
   * is given the launch of that command inside the containment instead. No containment, no run: a profile
   * that cannot be made refuses the command, it does not fall back to running it bare.
   */
  async function containShell(req: ToolRequest, outcome: Outcome): Promise<Outcome> {
    const containment = ctx.containment
    if (containment === undefined || (containment.profile === 'STANDARD' && containment.quiet !== true) || outcome.tool.behavior !== 'allow' || outcome.shell === undefined) return outcome
    const refuse = (detail: string): Outcome => {
      const reason = `Not run: ${detail} Nothing is run outside the containment in this project.`
      return { tool: deny(reason), audit: { classification: 'SYSTEM_SENSITIVE', provenance: 'not_applicable', decision: 'DENY', reason } }
    }
    if (containment.unavailable !== null) return refuse(`the ${containment.profile} execution profile is not available (${containment.unavailable}).`)
    // `grantedPush` is on an outcome that was an `ask` and is an `allow` now: the broker found the user's grant for it.
    const wrapped = await containment.wrap(outcome.shell.kind, outcome.shell.command, { gitOnly: outcome.shell.gitOnly, ...(outcome.shell.gitOnly && outcome.shell.gitScript !== undefined ? { gitScript: outcome.shell.gitScript } : {}), ...(outcome.shell.grantedPush !== undefined ? { grantedPush: outcome.shell.grantedPush } : {}) })
    if (!wrapped.ok) return refuse(wrapped.reason)
    // The tool's other inputs (its time limit, running in the background) stay the agent's; a request to leave the tool's own sandbox is dropped.
    const { dangerouslyDisableSandbox: _dropped, ...rest } = req.input
    return { ...outcome, tool: { behavior: 'allow', updatedInput: { ...rest, command: wrapped.command } } }
  }

  return async (req: ToolRequest): Promise<ToolDecision> => {
    try {
      const outcome = await containShell(req, throughBroker(req, await decide(req)))
      log(req, outcome)
      return outcome.tool
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const tool = deny(`Denied: the request could not be evaluated safely (${msg}).`)
      log(req, { tool })
      return tool
    }
  }
}
