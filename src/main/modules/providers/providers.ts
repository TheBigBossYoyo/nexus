import { NO_CAPABILITIES, PROVIDER_NAMES, type ProviderCapabilities, type ProviderId, type ProviderStatus } from '@shared/provider'
import type { AgentRuntime, RuntimeUsageReport, SessionSpec } from '@main/modules/agent-runtime'
import { runCommand } from './cli'
import { CODEX_DEFAULT_MODEL, CODEX_TOOL, CodexCliRuntime } from './codex-runtime'
import type { AgentRuntimeProvider, CommandRunner } from './types'

const iso = (): string => new Date().toISOString()
const firstLine = (text: string): string => (text.trim().split(/\r?\n/)[0] ?? '').trim().slice(0, 200)

/** One minimal session through a runtime: the answer to "does it work end to end". */
async function probeRuntime(runtime: AgentRuntime, model: string | null, cwd: string): Promise<{ ok: boolean; detail: string }> {
  const spec: SessionSpec = {
    agentId: `provider-probe-${Date.now().toString(36)}`,
    role: 'researcher',
    cwd,
    ...(model ? { model } : {}),
    maxTurns: 1,
    systemPromptAppend: '',
    prompt: 'Reply with the single word OK.',
    tools: [],
    authorize: async () => ({ behavior: 'deny', reason: 'A provider probe uses no tools.' }),
    requestApproval: async () => false,
    loadProjectSettings: false,
    subscriptionMode: true,
  }
  let handle
  try {
    handle = runtime.startSession(spec)
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
  const timer = setTimeout(() => void handle.stop(), 120_000)
  timer.unref()
  try {
    for await (const event of handle.events) {
      if (event.type === 'turn.completed') {
        handle.end()
        if (event.result.outcome === 'success') return { ok: true, detail: `Answered in ${Math.round(event.result.durationMs / 100) / 10} s.` }
        return { ok: false, detail: (event.result.errors[0] ?? `The session ended with ${event.result.outcome}.`).slice(0, 400) }
      }
      if (event.type === 'session.ended' && event.reason !== 'completed') return { ok: false, detail: (event.error ?? `The session ${event.reason}.`).slice(0, 400) }
    }
    return { ok: false, detail: 'The session ended without an answer.' }
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────────── Claude ─────────────────────────────

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  sessions: true,
  resume: true,
  structuredOutput: 'native',
  toolAuthorization: true,
  nexusTools: true,
  mcp: true,
  usageReport: true,
  confinement: 'nexus_policy',
  writes: true,
}

/** The required provider: the Claude Agent SDK runtime NEXUS has always used, unchanged. */
export class ClaudeAgentRuntimeProvider implements AgentRuntimeProvider {
  readonly id = 'claude' as const

  constructor(private readonly deps: { runtime: AgentRuntime; subscriptionMode: () => boolean; probeCwd: () => string }) {}

  async discover(): Promise<ProviderStatus> {
    const base = { id: this.id, displayName: PROVIDER_NAMES.claude, required: true, capabilities: CLAUDE_CAPABILITIES, checkedAt: iso() }
    try {
      const [account, capabilities] = await Promise.all([this.deps.runtime.getAccountInfo({ subscriptionMode: this.deps.subscriptionMode() }), this.deps.runtime.getCapabilities()])
      const unavailable = account.state === 'runtime_unavailable'
      return {
        ...base,
        installed: unavailable ? 'not_installed' : 'installed',
        version: account.claudeCodeVersion ?? capabilities.sdkVersion ?? null,
        auth: account.state === 'authenticated' ? 'authenticated' : account.state === 'authentication_required' ? 'auth_required' : 'unknown',
        authDetail: account.subscriptionType ?? (account.mode === 'api_key' ? 'API key' : null),
        supported: !unavailable,
        supportDetail: unavailable ? (account.error ?? 'The Claude runtime was not found.') : null,
        health: account.state === 'authenticated' ? 'healthy' : unavailable || account.state === 'authentication_required' ? 'unavailable' : 'unknown',
        healthDetail: account.error,
        models: capabilities.models.map((m) => ({ value: m.value, displayName: m.displayName })),
      }
    } catch (e) {
      return { ...base, installed: 'unknown', version: null, auth: 'unknown', authDetail: null, supported: true, supportDetail: null, health: 'unknown', healthDetail: e instanceof Error ? e.message.slice(0, 300) : String(e), models: [] }
    }
  }

  runtime(): AgentRuntime {
    return this.deps.runtime
  }

  defaultModel(): string | null {
    return null
  }

  async usageReport(): Promise<RuntimeUsageReport | null> {
    return (await this.deps.runtime.getUsageReport?.({ subscriptionMode: this.deps.subscriptionMode() }).catch(() => null)) ?? null
  }

  probe(): Promise<{ ok: boolean; detail: string }> {
    return probeRuntime(this.deps.runtime, null, this.deps.probeCwd())
  }
}

// ───────────────────────────── Codex ─────────────────────────────

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  sessions: true,
  resume: true,
  structuredOutput: 'prompted',
  toolAuthorization: false,
  nexusTools: false,
  mcp: false,
  usageReport: false,
  confinement: 'provider_sandbox',
  writes: false,
}

/** The oldest Codex command line tool whose `exec --json` events NEXUS was written against. */
export const CODEX_MIN_VERSION = [0, 124, 0] as const

export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const atLeast = (v: readonly number[], min: readonly number[]): boolean => {
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0)
  }
  return true
}

/**
 * Codex through its own command line tool. Detection asks the tool for its version and its login status
 * (`codex login status`); NEXUS never opens Codex's files and never starts a login.
 */
export class CodexRuntimeProvider implements AgentRuntimeProvider {
  readonly id = 'codex' as const
  private version: string | null = null
  private readonly codex: CodexCliRuntime

  constructor(private readonly deps: { run?: CommandRunner; runtime?: CodexCliRuntime; snapshot?: (cwd: string) => Promise<string | null>; probeCwd: () => string }) {
    this.codex = deps.runtime ?? new CodexCliRuntime({ version: () => this.version, ...(deps.snapshot ? { snapshot: deps.snapshot } : {}) })
  }

  async discover(): Promise<ProviderStatus> {
    const run = this.deps.run ?? runCommand
    const base = { id: this.id, displayName: PROVIDER_NAMES.codex, required: false, checkedAt: iso(), models: [{ value: CODEX_DEFAULT_MODEL, displayName: CODEX_DEFAULT_MODEL }] }
    const version = await run(CODEX_TOOL, ['--version'], { timeoutMs: 15_000 })
    const parsed = version.code === 0 ? parseVersion(version.stdout) : null
    if (!parsed) {
      this.version = null
      return { ...base, models: [], installed: 'not_installed', version: null, auth: 'unknown', authDetail: null, supported: false, supportDetail: 'The Codex command line tool was not found on PATH.', health: 'unavailable', healthDetail: null, capabilities: NO_CAPABILITIES }
    }
    this.version = parsed.join('.')
    const supported = atLeast(parsed, CODEX_MIN_VERSION)
    const login = await run(CODEX_TOOL, ['login', 'status'], { timeoutMs: 15_000 })
    const said = firstLine(`${login.stdout}\n${login.stderr}`)
    const authenticated = login.code === 0 && /logged in/i.test(said) && !/not logged in/i.test(said)
    return {
      ...base,
      installed: 'installed',
      version: this.version,
      auth: authenticated ? 'authenticated' : login.code === null ? 'unknown' : 'auth_required',
      authDetail: said || null,
      supported,
      supportDetail: supported ? null : `Codex ${this.version} is older than ${CODEX_MIN_VERSION.join('.')}, the oldest version NEXUS can drive.`,
      // Detection sends no prompt, so whether a session works is not known until one ran or the user probes.
      health: !supported || !authenticated ? 'unavailable' : 'unknown',
      healthDetail: null,
      capabilities: supported ? CODEX_CAPABILITIES : NO_CAPABILITIES,
    }
  }

  runtime(): AgentRuntime {
    return this.codex
  }

  defaultModel(): string {
    return CODEX_DEFAULT_MODEL
  }

  /** The Codex command line tool reports no plan window without a prompt. */
  async usageReport(): Promise<RuntimeUsageReport | null> {
    return null
  }

  probe(): Promise<{ ok: boolean; detail: string }> {
    return probeRuntime(this.codex, CODEX_DEFAULT_MODEL, this.deps.probeCwd())
  }
}

// ───────────────────────────── Gemini ─────────────────────────────

/**
 * Gemini is detected only. NEXUS 0.6 has no runtime adapter for it, so it cannot be enabled; the Providers
 * page says so instead of offering a switch that does nothing.
 */
export class GeminiRuntimeProvider implements AgentRuntimeProvider {
  readonly id = 'gemini' as const

  constructor(private readonly deps: { run?: CommandRunner } = {}) {}

  async discover(): Promise<ProviderStatus> {
    const run = this.deps.run ?? runCommand
    const version = await run('gemini', ['--version'], { timeoutMs: 15_000 })
    const parsed = version.code === 0 ? parseVersion(version.stdout) : null
    return {
      id: this.id,
      displayName: PROVIDER_NAMES.gemini,
      required: false,
      installed: parsed ? 'installed' : 'not_installed',
      version: parsed ? parsed.join('.') : null,
      auth: 'unknown',
      authDetail: null,
      supported: false,
      supportDetail: parsed ? 'NEXUS 0.6 detects the Gemini command line tool but has no runtime adapter for it.' : 'The Gemini command line tool was not found on PATH.',
      health: 'unavailable',
      healthDetail: null,
      models: [],
      capabilities: NO_CAPABILITIES,
      checkedAt: iso(),
    }
  }

  runtime(): null {
    return null
  }

  defaultModel(): null {
    return null
  }

  async usageReport(): Promise<null> {
    return null
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: 'NEXUS has no runtime adapter for Gemini.' }
  }
}

// ───────────────────────────── fakes (tests and the scripted app) ─────────────────────────────

/** A provider with a scripted runtime and a status the test controls. Never used with a real runtime. */
export class FakeRuntimeProvider implements AgentRuntimeProvider {
  status: ProviderStatus
  probeResult = { ok: true, detail: 'Answered.' }
  usage: RuntimeUsageReport | null = null

  constructor(
    readonly id: ProviderId,
    private readonly fake: AgentRuntime | null,
    overrides: Partial<ProviderStatus> = {},
    private readonly model: string | null = null,
  ) {
    const capabilities: ProviderCapabilities = fake ? (id === 'claude' ? CLAUDE_CAPABILITIES : { ...CODEX_CAPABILITIES, writes: true }) : NO_CAPABILITIES
    this.status = {
      id,
      displayName: PROVIDER_NAMES[id],
      required: id === 'claude',
      installed: 'installed',
      version: '0.0.0-fake',
      auth: 'authenticated',
      authDetail: 'Scripted',
      supported: fake !== null,
      supportDetail: null,
      health: 'unknown',
      healthDetail: null,
      models: model ? [{ value: model, displayName: model }] : [],
      capabilities,
      checkedAt: iso(),
      ...overrides,
    }
  }

  async discover(): Promise<ProviderStatus> {
    return { ...this.status, checkedAt: iso() }
  }

  runtime(): AgentRuntime | null {
    return this.fake
  }

  defaultModel(): string | null {
    return this.model
  }

  async usageReport(): Promise<RuntimeUsageReport | null> {
    return this.usage
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return this.probeResult
  }
}
