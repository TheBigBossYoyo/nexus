import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER_POLICY,
  enableBlocker,
  NO_CAPABILITIES,
  providerSignature,
  routeSession,
  summarizePerformance,
  type ProviderPolicy,
  type ProviderSession,
  type ProviderStatus,
} from '@shared/provider'
import { ipcInputs } from '@shared/ipc'
import { completeWith, FakeAgentRuntime, type AgentEvent, type AgentSessionHandle, type SessionSpec, type TurnResult } from '@main/modules/agent-runtime'
import { createRepositories, MIGRATIONS, openDatabase, runMigrations, type Database, type Repositories } from '@main/modules/persistence'
import {
  ClaudeAgentRuntimeProvider,
  cliInvocation,
  resolveTool,
  toolEnv,
  codexArgs,
  CodexCliRuntime,
  codexPrompt,
  CodexRuntimeProvider,
  CODEX_CAPABILITIES,
  FAILURES_UNTIL_UNAVAILABLE,
  FakeRuntimeProvider,
  GeminiRuntimeProvider,
  parseVersion,
  ProviderService,
  type CodexRuntimeOptions,
  type CommandRunner,
} from '@main/modules/providers'
import { EventBus } from '@main/modules/events'
import { UsageIntelligenceService } from '@main/modules/usage'
import { makeAgent, makeProject, makeRun } from '../persistence/fixtures'

const spec = (overrides: Partial<SessionSpec> = {}): SessionSpec => ({
  agentId: 'agent-1',
  role: 'reviewer',
  cwd: process.cwd(),
  model: 'claude-model',
  maxTurns: 5,
  systemPromptAppend: 'You review.',
  prompt: 'Review the change.',
  tools: [],
  authorize: async () => ({ behavior: 'allow' }),
  requestApproval: async () => true,
  loadProjectSettings: false,
  subscriptionMode: true,
  ...overrides,
})

async function collect(handle: AgentSessionHandle): Promise<{ events: AgentEvent[]; turn: TurnResult | null; ended: Extract<AgentEvent, { type: 'session.ended' }> | null }> {
  const events: AgentEvent[] = []
  let turn: TurnResult | null = null
  let ended: Extract<AgentEvent, { type: 'session.ended' }> | null = null
  for await (const event of handle.events) {
    events.push(event)
    if (event.type === 'turn.completed') {
      turn = event.result
      handle.end()
    }
    if (event.type === 'session.ended') ended = event
  }
  return { events, turn, ended }
}

const status = (id: ProviderStatus['id'], overrides: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  displayName: id,
  required: id === 'claude',
  installed: 'installed',
  version: '1.0.0',
  auth: 'authenticated',
  authDetail: null,
  supported: true,
  supportDetail: null,
  health: 'unknown',
  healthDetail: null,
  models: [],
  capabilities: { ...CODEX_CAPABILITIES, writes: id === 'claude' },
  checkedAt: 'now',
  ...overrides,
})

const policy = (overrides: Partial<ProviderPolicy> = {}): ProviderPolicy => ({ ...DEFAULT_PROVIDER_POLICY, ...overrides })
const REVIEW_BY_CODEX = policy({ enabled: { claude: true, codex: true, gemini: false }, crossModelReview: { enabled: true, reviewer: 'codex' } })

describe('provider routing (pure)', () => {
  const all = [status('claude'), status('codex'), status('gemini', { installed: 'not_installed', supported: false, capabilities: NO_CAPABILITIES })]

  it('sends everything to Claude under the default policy, whatever is installed', () => {
    for (const role of ['planner', 'worker', 'reviewer', 'security_reviewer', 'verifier'] as const) {
      expect(routeSession({ role }, DEFAULT_PROVIDER_POLICY, all)).toMatchObject({ provider: 'claude', requested: 'claude', fallbackReason: null })
    }
    // Enabling a provider routes nothing by itself: a use must be switched on too.
    expect(routeSession({ role: 'reviewer' }, policy({ enabled: { claude: true, codex: true, gemini: false } }), all).provider).toBe('claude')
  })

  it('cross-model review sends reviewers to the other provider and nothing else', () => {
    expect(routeSession({ role: 'reviewer' }, REVIEW_BY_CODEX, all)).toMatchObject({ provider: 'codex', requested: 'codex', fallbackReason: null })
    expect(routeSession({ role: 'security_reviewer' }, REVIEW_BY_CODEX, all).provider).toBe('codex')
    // The implementation and the verifier stay with Claude.
    for (const role of ['worker', 'verifier', 'planner', 'debugger'] as const) expect(routeSession({ role }, REVIEW_BY_CODEX, all).provider).toBe('claude')
  })

  it('never routes to a provider the policy has not enabled, even when a use names it', () => {
    const off = policy({ crossModelReview: { enabled: true, reviewer: 'codex' } })
    const decision = routeSession({ role: 'reviewer' }, off, all)
    expect(decision).toMatchObject({ provider: 'claude', requested: 'codex' })
    expect(decision.fallbackReason).toContain('not enabled')
  })

  it('falls back to Claude with the reason, or refuses when the policy allows no fallback', () => {
    const cases: [Partial<ProviderStatus>, string][] = [
      [{ installed: 'not_installed' }, 'not installed'],
      [{ auth: 'auth_required' }, 'needs authentication'],
      [{ health: 'unavailable', healthDetail: '3 failed sessions' }, 'unavailable: 3 failed sessions'],
      [{ supported: false, supportDetail: 'Codex 0.1.0 is too old.' }, 'too old'],
    ]
    for (const [patch, text] of cases) {
      const statuses = [status('claude'), status('codex', patch)]
      const decision = routeSession({ role: 'reviewer' }, REVIEW_BY_CODEX, statuses)
      expect(decision.provider, text).toBe('claude')
      expect(decision.fallbackReason, text).toContain(text)
      const strict = routeSession({ role: 'reviewer' }, { ...REVIEW_BY_CODEX, fallbackToClaude: false }, statuses)
      expect(strict.provider, text).toBeNull()
      expect(strict.fallbackReason, text).toContain('no fallback')
    }
    // A provider that was never detected is not usable either.
    expect(routeSession({ role: 'reviewer' }, REVIEW_BY_CODEX, [status('claude')]).fallbackReason).toContain('not detected')
    // A degraded provider is still tried.
    expect(routeSession({ role: 'reviewer' }, REVIEW_BY_CODEX, [status('claude'), status('codex', { health: 'degraded' })]).provider).toBe('codex')
  })

  it('heterogeneous speculation gives candidate B to the other provider only when that provider may write', () => {
    const hetero = policy({ enabled: { claude: true, codex: true, gemini: false }, heterogeneousSpeculation: { enabled: true, secondCandidate: 'codex' } })
    const writing = [status('claude'), status('codex', { capabilities: { ...CODEX_CAPABILITIES, writes: true } })]
    expect(routeSession({ role: 'worker', label: 'Worker/api · candidate B' }, hetero, writing).provider).toBe('codex')
    expect(routeSession({ role: 'worker', label: 'Worker/api · candidate A' }, hetero, writing).provider).toBe('claude')
    expect(routeSession({ role: 'worker', label: 'Worker/api' }, hetero, writing).provider).toBe('claude')
    const readOnly = routeSession({ role: 'worker', label: 'Worker/api · candidate B' }, hetero, all)
    expect(readOnly.provider).toBe('claude')
    expect(readOnly.fallbackReason).toContain('read-only')
  })

  it('a resumed session stays with the provider that owns it', () => {
    expect(routeSession({ role: 'reviewer', resumeProvider: 'codex' }, policy({ enabled: { claude: true, codex: true, gemini: false } }), all)).toMatchObject({ provider: 'codex', requested: 'codex' })
    expect(routeSession({ role: 'reviewer', resumeProvider: 'claude' }, REVIEW_BY_CODEX, all).provider).toBe('claude')
    // A session of a provider the user has since switched off is not resumed there, and not sent elsewhere.
    const off = routeSession({ role: 'reviewer', resumeProvider: 'codex' }, DEFAULT_PROVIDER_POLICY, all)
    expect(off.provider).toBeNull()
    expect(off.fallbackReason).toContain('cannot be resumed')
  })

  it('says what stops a provider from being enabled', () => {
    expect(enableBlocker(status('claude'))).toBeNull()
    expect(enableBlocker(status('codex'))).toBeNull()
    expect(enableBlocker(status('codex', { installed: 'not_installed' }))).toContain('not installed')
    expect(enableBlocker(status('codex', { auth: 'auth_required' }))).toContain('never handles its credentials')
    expect(enableBlocker(status('gemini', { supported: false, supportDetail: 'No adapter.' }))).toBe('No adapter.')
  })

  it('summarizes sessions as counts and names who did what', () => {
    const s = (provider: ProviderSession['provider'], requested: ProviderSession['requested'], outcome: ProviderSession['outcome'], role: ProviderSession['role'] = 'reviewer'): ProviderSession => ({ id: `${provider}-${Math.random()}`, runId: 'r', agentId: 'a', role, label: null, requested, provider, model: provider === 'codex' ? 'gpt-x' : 'claude-x', runtimeVersion: null, authMode: null, reason: '', fallbackReason: null, sessionId: null, outcome, error: null, inputTokens: 10, outputTokens: 2, createdAt: '2026-10-05T00:00:00.000Z', endedAt: null })
    const sessions = [s('claude', 'claude', 'completed', 'worker'), s('codex', 'codex', 'completed'), s('codex', 'codex', 'failed'), s('claude', 'codex', 'completed')]
    const summary = summarizePerformance(sessions)
    expect(summary.find((p) => p.provider === 'codex')).toMatchObject({ sessions: 2, completed: 1, failed: 1, fallbacksFrom: 1, inputTokens: 20, outputTokens: 4 })
    expect(summary.find((p) => p.provider === 'claude')).toMatchObject({ sessions: 2, completed: 2, fallbacksFrom: 0 })
    expect(summary.find((p) => p.provider === 'gemini')).toMatchObject({ sessions: 0, lastUsedAt: null })
    expect(providerSignature(sessions)).toBe('reviewer=codex:gpt-x')
    expect(providerSignature(sessions.filter((x) => x.provider === 'claude'))).toBe('')
  })
})

describe('provider command lines', () => {
  it('starts a tool only by its absolute path and with checked arguments, through the system cmd.exe on Windows', () => {
    const shim = 'C:\\Users\\me\\scoop\\bin\\codex.cmd'
    expect(cliInvocation(shim, ['--version'], 'win32', { SystemRoot: 'C:\\Windows' })).toEqual({ command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', `""${shim}" --version"`], verbatim: true })
    expect(cliInvocation('C:\\Program Files (x86)\\tool\\codex.cmd', ['login', 'status'], 'win32', { SystemRoot: 'C:\\Windows' }).args[3]).toBe('""C:\\Program Files (x86)\\tool\\codex.cmd" login status"')
    expect(cliInvocation('C:\\tools\\codex.exe', ['login', 'status'], 'win32')).toEqual({ command: 'C:\\tools\\codex.exe', args: ['login', 'status'], verbatim: false })
    for (const bad of ['a b', 'x&calc', 'x|y', '"q"', '$(id)', 'a;b', '%PATH%', 'x^y', '`id`', '']) expect(() => cliInvocation(shim, [bad], 'win32'), bad).toThrow(/unsafe/)
    // A bare name would be looked up by cmd.exe in the working directory first: never used.
    expect(() => cliInvocation('codex', ['--version'], 'win32')).toThrow(/absolute path/)
    for (const path of ['C:\\a%b\\codex.cmd', 'C:\\a&b\\codex.cmd', 'C:\\a"b\\codex.cmd', 'C:\\a^b\\codex.cmd']) expect(() => cliInvocation(path, [], 'win32'), path).toThrow(/cmd.exe interprets/)
    expect(toolEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', NODE_OPTIONS: '--require x' })).toEqual({ PATH: 'x', NoDefaultCurrentDirectoryInExePath: '1' })
  })

  it('finds a tool on PATH only: never in the working directory, never through a relative PATH entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-tool-'))
    try {
      const bin = join(root, 'bin')
      const work = join(root, 'work')
      mkdirSync(bin)
      mkdirSync(join(work, 'tools'), { recursive: true })
      const name = process.platform === 'win32' ? 'faketool.cmd' : 'faketool'
      for (const dir of [bin, work, join(work, 'tools')]) writeFileSync(join(dir, name), process.platform === 'win32' ? '@echo real\r\n' : '#!/bin/sh\necho real\n', { mode: 0o755 })
      const env = (path: string): NodeJS.ProcessEnv => ({ PATH: path, PATHEXT: '.COM;.EXE;.BAT;.CMD' })
      // On PATH: found, by absolute path.
      expect(await resolveTool('faketool', work, env(bin))).toBe(join(bin, name))
      // Only in the working directory (which cmd.exe would search first): not found.
      expect(await resolveTool('faketool', work, env(join(root, 'empty')))).toBeNull()
      // PATH entries inside the working directory, and relative ones, are ignored.
      expect(await resolveTool('faketool', work, env([join(work, 'tools'), '.', 'tools', work].join(delimiter)))).toBeNull()
      expect(await resolveTool('faketool', work, env([join(work, 'tools'), bin].join(delimiter)))).toBe(join(bin, name))
      expect(await resolveTool('../bin/faketool', work, env(bin))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds Codex turns that are always read-only and never carry the prompt', () => {
    expect(codexArgs({ model: 'gpt-5.5' })).toEqual(['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5.5', '-c', 'sandbox_mode=read-only', '-s', 'read-only', '--color', 'never', '-'])
    // A session id that looks like an option is refused.
    expect(() => codexArgs({ model: 'gpt-5.5', resumeSessionId: '--dangerously-bypass-approvals-and-sandbox' })).toThrow(/session id/)
    expect(codexArgs({ model: 'gpt-5.5', resumeSessionId: '01a109bd-00c9-7721-b081-a10a59244867' })).toEqual(['exec', 'resume', '01a109bd-00c9-7721-b081-a10a59244867', '--json', '--skip-git-repo-check', '-m', 'gpt-5.5', '-c', 'sandbox_mode=read-only', '-'])
    expect(() => codexArgs({ model: 'x; rm -rf' })).toThrow()
    expect(() => codexArgs({ model: 'gpt', resumeSessionId: 'abc & calc' })).toThrow()
    for (const args of [codexArgs({ model: 'm' }), codexArgs({ model: 'm', resumeSessionId: 'abcdefgh-1' })]) expect(() => cliInvocation('C:\\bin\\codex.cmd', args, 'win32')).not.toThrow()
    const prompt = codexPrompt({ systemPromptAppend: 'SYSTEM', prompt: 'TASK', outputSchema: { type: 'object' } })
    expect(prompt).toContain('SYSTEM')
    expect(prompt).toContain('TASK')
    expect(prompt).toContain('read-only')
    expect(prompt).toContain('{"type":"object"}')
    expect(parseVersion('codex-cli 0.130.0')).toEqual([0, 130, 0])
    expect(parseVersion('nothing')).toBeNull()
  })
})

/** A scripted `codex exec` process: it is given the prompt and prints the lines the script returns. */
function fakeCodex(script: (call: { args: readonly string[]; prompt: string; index: number }) => string[]): { exec: NonNullable<CodexRuntimeOptions['exec']>; calls: { args: readonly string[]; prompt: string; cwd: string }[] } {
  const calls: { args: readonly string[]; prompt: string; cwd: string }[] = []
  const exec: NonNullable<CodexRuntimeOptions['exec']> = async (args, cwd, prompt) => {
    calls.push({ args, prompt, cwd })
    await new Promise((resolve) => setImmediate(resolve))
    return { stdout: script({ args, prompt, index: calls.length - 1 }).join('\n'), stderr: '', exitCode: 0, timedOut: false, aborted: false }
  }
  return { exec, calls }
}

const J = JSON.stringify
const THREAD = '01a109bd-00c9-7721-b081-a10a59244867'

describe('Codex command line runtime (scripted process)', () => {
  it('turns the JSON events of a turn into a session: id, text, a tool call, usage, structured output', async () => {
    const codex = fakeCodex(() => [
      'Opération réussie : not JSON, ignored',
      J({ type: 'thread.started', thread_id: THREAD }),
      J({ type: 'turn.started' }),
      J({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'git diff', status: 'in_progress' } }),
      J({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'git diff', aggregated_output: 'diff --git', exit_code: 0 } }),
      J({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Looks right.\n```json\n{"verdict":"approve","findings":[]}\n```' } }),
      J({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 40 } }),
    ])
    const runtime = new CodexCliRuntime({ exec: codex.exec })
    const { model: _claudeModel, ...withoutModel } = spec({ outputSchema: { type: 'object' } })
    const out = await collect(runtime.startSession(withoutModel))
    expect(out.events.map((e) => e.type)).toEqual(['session.started', 'tool.started', 'tool.completed', 'text', 'turn.completed', 'session.ended'])
    expect(out.events[0]).toMatchObject({ sessionId: THREAD, model: 'gpt-5.5' })
    expect(out.turn).toMatchObject({ outcome: 'success', structuredOutput: { verdict: 'approve', findings: [] }, usage: [{ model: 'gpt-5.5', inputTokens: 1200, outputTokens: 40, cacheReadTokens: 200 }] })
    expect(out.ended).toMatchObject({ reason: 'completed', error: null })
    // The prompt went through stdin only.
    expect(codex.calls[0]!.args).toEqual(codexArgs({ model: 'gpt-5.5' }))
    expect(codex.calls[0]!.prompt).toContain('Review the change.')
    expect(codex.calls[0]!.args.join(' ')).not.toContain('Review')
  })

  it('a follow-up message resumes the same Codex session', async () => {
    const codex = fakeCodex(({ index }) => [J({ type: 'thread.started', thread_id: THREAD }), J({ type: 'item.completed', item: { type: 'agent_message', text: `answer ${index}` } }), J({ type: 'turn.completed', usage: {} })])
    const runtime = new CodexCliRuntime({ exec: codex.exec })
    const handle = runtime.startSession(spec())
    const texts: string[] = []
    let turns = 0
    for await (const event of handle.events) {
      if (event.type === 'text') texts.push(event.text)
      if (event.type === 'turn.completed') {
        turns++
        if (turns === 1) handle.send('And the tests?')
        else handle.end()
      }
    }
    expect(texts).toEqual(['answer 0', 'answer 1'])
    expect(codex.calls[1]!.args.slice(0, 3)).toEqual(['exec', 'resume', THREAD])
    expect(codex.calls[1]!.prompt).toBe('And the tests?')
    expect(handle.sessionId()).toBe(THREAD)
  })

  it('an error of Codex is an error of that session, never a usage limit', async () => {
    const codex = fakeCodex(() => [J({ type: 'thread.started', thread_id: THREAD }), J({ type: 'error', message: 'You have hit your usage limit. Try again later.' }), J({ type: 'turn.failed', error: { message: 'You have hit your usage limit. Try again later.' } })])
    const out = await collect(new CodexCliRuntime({ exec: codex.exec }).startSession(spec()))
    expect(out.turn).toMatchObject({ outcome: 'error', errors: ['You have hit your usage limit. Try again later.'] })
    expect(out.events.some((e) => e.type === 'rate_limit' || e.type === 'throttle')).toBe(false)
  })

  it('an answer without JSON fails structured output; a process that prints nothing is an error', async () => {
    const noJson = fakeCodex(() => [J({ type: 'thread.started', thread_id: THREAD }), J({ type: 'item.completed', item: { type: 'agent_message', text: 'Fine.' } }), J({ type: 'turn.completed', usage: {} })])
    expect((await collect(new CodexCliRuntime({ exec: noJson.exec }).startSession(spec({ outputSchema: { type: 'object' } })))).turn?.outcome).toBe('structured_output_failed')
    const silent = fakeCodex(() => [])
    const out = await collect(new CodexCliRuntime({ exec: silent.exec }).startSession(spec()))
    expect(out.turn?.outcome).toBe('error')
  })

  it('refuses a writing role, and discards a read-only session that changed the working directory', async () => {
    const codex = fakeCodex(() => [J({ type: 'thread.started', thread_id: THREAD }), J({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }), J({ type: 'turn.completed', usage: {} })])
    expect(() => new CodexCliRuntime({ exec: codex.exec }).startSession(spec({ role: 'worker' }))).toThrow(/read-only/)
    let n = 0
    const changed = new CodexCliRuntime({ exec: codex.exec, snapshot: async () => `state-${n++}` })
    const out = await collect(changed.startSession(spec()))
    expect(out.turn?.outcome).toBe('error')
    expect(out.turn?.errors.join(' ')).toContain('changed the working directory')
    expect(out.ended).toMatchObject({ reason: 'crashed' })
    expect(out.turn?.text).toBe('')
    // The directory is not trusted again: a second attempt would start from the changed state and pass.
    expect(() => changed.startSession(spec())).toThrow(/No further Codex session/)
    const same = new CodexCliRuntime({ exec: codex.exec, snapshot: async () => 'same' })
    expect((await collect(same.startSession(spec()))).turn?.outcome).toBe('success')
    // Fail closed: a directory whose state cannot be read gets no session at all, and a state that cannot be read afterwards discards the result.
    const before = codex.calls.length
    const blind = await collect(new CodexCliRuntime({ exec: codex.exec, snapshot: async () => null }).startSession(spec()))
    expect(blind.turn).toBeNull()
    expect(blind.ended?.error).toContain('cannot verify')
    expect(codex.calls.length).toBe(before)
    let calls = 0
    const lost = await collect(new CodexCliRuntime({ exec: codex.exec, snapshot: async () => (calls++ === 0 ? 'state' : null) }).startSession(spec()))
    expect(lost.turn?.outcome).toBe('error')
    expect(lost.ended?.reason).toBe('crashed')
    // An answer that is JSON but not an object is not a structured answer.
    const list = fakeCodex(() => [J({ type: 'thread.started', thread_id: THREAD }), J({ type: 'item.completed', item: { type: 'agent_message', text: '```json\n[1, 2]\n```' } }), J({ type: 'turn.completed', usage: {} })])
    expect((await collect(new CodexCliRuntime({ exec: list.exec }).startSession(spec({ outputSchema: { type: 'object' } })))).turn?.outcome).toBe('structured_output_failed')
  })
})

describe('provider discovery', () => {
  const runner =
    (answers: Record<string, { code: number | null; stdout?: string; stderr?: string }>): CommandRunner =>
    async (tool, args) => {
      const a = answers[`${tool} ${args.join(' ')}`] ?? { code: null }
      return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '', error: a.code === null ? 'not found' : null }
    }

  it('Codex: installed and signed in, signed out, too old, missing', async () => {
    const ok = await new CodexRuntimeProvider({ run: runner({ 'codex --version': { code: 0, stdout: 'codex-cli 0.130.0\n' }, 'codex login status': { code: 0, stdout: 'Logged in using ChatGPT\n' } }), probeCwd: () => '.' }).discover()
    expect(ok).toMatchObject({ installed: 'installed', version: '0.130.0', auth: 'authenticated', authDetail: 'ChatGPT login', supported: true, health: 'unknown', capabilities: { writes: false, toolAuthorization: false, confinement: 'provider_sandbox', structuredOutput: 'prompted' } })
    // What the tool prints about the login is never stored: only the kind of login.
    const named = await new CodexRuntimeProvider({ run: runner({ 'codex --version': { code: 0, stdout: 'codex-cli 0.130.0' }, 'codex login status': { code: 0, stdout: 'Logged in as someone@example.com using an API key sk-abc' } }), probeCwd: () => '.' }).discover()
    expect(named.authDetail).toBe('API key')
    const out = await new CodexRuntimeProvider({ run: runner({ 'codex --version': { code: 0, stdout: 'codex-cli 0.130.0' }, 'codex login status': { code: 1, stderr: 'Not logged in' } }), probeCwd: () => '.' }).discover()
    expect(out).toMatchObject({ installed: 'installed', auth: 'auth_required', authDetail: null, health: 'unavailable' })
    const old = await new CodexRuntimeProvider({ run: runner({ 'codex --version': { code: 0, stdout: 'codex-cli 0.98.0' }, 'codex login status': { code: 0, stdout: 'Logged in using ChatGPT' } }), probeCwd: () => '.' }).discover()
    expect(old).toMatchObject({ supported: false, health: 'unavailable', capabilities: { sessions: false } })
    expect(old.supportDetail).toContain('older than')
    const missing = await new CodexRuntimeProvider({ run: runner({}), probeCwd: () => '.' }).discover()
    expect(missing).toMatchObject({ installed: 'not_installed', supported: false, health: 'unavailable', version: null })
  })

  it('Gemini is detected and never offered; Claude reports what its runtime says', async () => {
    const gemini = await new GeminiRuntimeProvider({ run: runner({ 'gemini --version': { code: 0, stdout: '0.9.1' } }) }).discover()
    expect(gemini).toMatchObject({ installed: 'installed', version: '0.9.1', supported: false, capabilities: { sessions: false } })
    expect(enableBlocker(gemini)).toContain('no runtime adapter')
    expect(await new GeminiRuntimeProvider({ run: runner({}) }).discover()).toMatchObject({ installed: 'not_installed' })
    const fake = new FakeAgentRuntime({ script: completeWith({ text: 'OK' }) })
    const claude = new ClaudeAgentRuntimeProvider({ runtime: fake, subscriptionMode: () => true, probeCwd: () => process.cwd() })
    const found = await claude.discover()
    expect(found).toMatchObject({ id: 'claude', required: true, installed: 'installed', auth: 'authenticated', supported: true, health: 'healthy', capabilities: { writes: true, toolAuthorization: true, nexusTools: true } })
    expect(await claude.probe()).toMatchObject({ ok: true })
  })
})

describe('provider service: routing real sessions, fallback, outage, recovery', () => {
  let db: Database
  let repos: Repositories
  afterEach(() => db.close())

  function rig(options: { codex?: Partial<ProviderStatus>; codexScript?: ConstructorParameters<typeof FakeAgentRuntime>[0] } = {}) {
    db = openDatabase(':memory:')
    repos = createRepositories(db)
    const project = repos.projects.insert(makeProject())
    const run = repos.runs.insert(makeRun(project.id))
    const agent = repos.agents.insert(makeAgent(run.id, null))
    const claudeRuntime = new FakeAgentRuntime({ script: completeWith({ text: 'claude says ok' }) })
    const codexRuntime = new FakeAgentRuntime(options.codexScript ?? { script: completeWith({ text: 'codex says ok' }) })
    const claude = new FakeRuntimeProvider('claude', claudeRuntime)
    const codex = new FakeRuntimeProvider('codex', codexRuntime, options.codex ?? {}, 'gpt-fake')
    const gemini = new FakeRuntimeProvider('gemini', null, { auth: 'auth_required' })
    const service = new ProviderService({ providers: [claude, codex, gemini], sessions: repos.providerSessions, settings: repos.settings, runOfAgent: (id) => repos.agents.get(id)?.runId ?? null })
    return { service, claudeRuntime, codexRuntime, claude, codex, gemini, run, agent }
  }

  it('Claude-only operation is unchanged: every session goes to Claude and is recorded', async () => {
    const r = rig()
    await r.service.refresh()
    expect(r.service.policy()).toEqual(DEFAULT_PROVIDER_POLICY)
    const out = await collect(r.service.router.startSession(spec({ agentId: r.agent.id, role: 'worker' })))
    expect(out.turn?.text).toBe('claude says ok')
    expect(r.claudeRuntime.sessions).toHaveLength(1)
    expect(r.claudeRuntime.sessions[0]!.model).toBe('claude-model')
    expect(r.codexRuntime.sessions).toHaveLength(0)
    expect(r.service.sessionsOfRun(r.run.id)).toMatchObject([{ provider: 'claude', requested: 'claude', outcome: 'completed', fallbackReason: null, role: 'worker', agentId: r.agent.id }])
    expect((await r.service.router.getAccountInfo({ subscriptionMode: true })).state).toBe('authenticated')
  })

  it('a provider cannot be enabled while it cannot work, and a use needs its provider enabled', async () => {
    const r = rig()
    await r.service.refresh()
    expect(() => r.service.setPolicy({ ...DEFAULT_PROVIDER_POLICY, enabled: { claude: true, codex: false, gemini: true } })).toThrow(/cannot run sessions|not signed in/)
    expect(() => r.service.setPolicy({ ...DEFAULT_PROVIDER_POLICY, crossModelReview: { enabled: true, reviewer: 'codex' } })).toThrow(/not enabled/)
    expect(() => r.service.setPolicy({ ...REVIEW_BY_CODEX, crossModelReview: { enabled: true, reviewer: 'claude' } })).toThrow(/other than Claude/)
    expect(() => r.service.setPolicy({ ...DEFAULT_PROVIDER_POLICY, enabled: { claude: false, codex: false, gemini: false } })).toThrow(/Invalid provider policy/)
    expect(r.service.setPolicy(REVIEW_BY_CODEX)).toEqual(REVIEW_BY_CODEX)
    expect(r.service.policy()).toEqual(REVIEW_BY_CODEX)
    expect(ipcInputs['providers.setPolicy'].safeParse({ policy: REVIEW_BY_CODEX, extra: 1 }).success).toBe(false)
  })

  it('cross-model review: the reviewer runs on the other provider with its own model; usage stays separate', async () => {
    const r = rig()
    await r.service.refresh()
    r.service.setPolicy(REVIEW_BY_CODEX)
    const worker = await collect(r.service.router.startSession(spec({ agentId: r.agent.id, role: 'worker' })))
    const review = await collect(r.service.router.startSession(spec({ agentId: r.agent.id, role: 'reviewer' })))
    const verify = await collect(r.service.router.startSession(spec({ agentId: r.agent.id, role: 'verifier' })))
    expect([worker.turn?.text, review.turn?.text, verify.turn?.text]).toEqual(['claude says ok', 'codex says ok', 'claude says ok'])
    expect(r.codexRuntime.sessions).toHaveLength(1)
    // The Claude model name was not handed to the other provider.
    expect(r.codexRuntime.sessions[0]!.model).toBe('gpt-fake')
    const sessions = r.service.sessionsOfRun(r.run.id)
    expect(sessions.map((s) => [s.role, s.provider, s.model])).toEqual([
      ['worker', 'claude', 'claude-model'],
      ['reviewer', 'codex', 'gpt-fake'],
      ['verifier', 'claude', 'claude-model'],
    ])
    const overview = await r.service.overview()
    expect(overview.usage.find((u) => u.provider === 'codex')).toMatchObject({ observed: { sessions: 1 }, windows: [], windowsSource: 'not_exposed' })
    expect(overview.usage.find((u) => u.provider === 'claude')?.observed.sessions).toBe(2)
    expect(overview.performance.find((p) => p.provider === 'codex')).toMatchObject({ sessions: 1, completed: 1, failed: 0 })
  })

  it('an outage: failed sessions degrade the provider, then Claude reviews instead with the reason recorded; a probe recovers it', async () => {
    const r = rig({ codexScript: { script: async () => { throw new Error('codex is down') } } })
    await r.service.refresh()
    r.service.setPolicy(REVIEW_BY_CODEX)
    for (let i = 0; i < FAILURES_UNTIL_UNAVAILABLE; i++) {
      const out = await collect(r.service.router.startSession(spec({ agentId: r.agent.id })))
      expect(out.ended).toMatchObject({ reason: 'crashed' })
      expect(r.service.list().find((s) => s.id === 'codex')?.health).toBe(i + 1 >= FAILURES_UNTIL_UNAVAILABLE ? 'unavailable' : 'degraded')
    }
    // NEXUS as a whole is unaffected: the next review is done by Claude.
    const fallback = await collect(r.service.router.startSession(spec({ agentId: r.agent.id })))
    expect(fallback.turn?.text).toBe('claude says ok')
    const last = r.service.sessionsOfRun(r.run.id).at(-1)!
    expect(last).toMatchObject({ requested: 'codex', provider: 'claude', outcome: 'completed' })
    expect(last.fallbackReason).toContain('Codex is unavailable')
    expect(last.fallbackReason).toContain('codex is down')
    expect((await r.service.overview()).performance.find((p) => p.provider === 'codex')).toMatchObject({ failed: FAILURES_UNTIL_UNAVAILABLE, fallbacksFrom: 1 })

    // Without fallback the session is refused and says why; nothing is sent anywhere.
    r.service.setPolicy({ ...REVIEW_BY_CODEX, fallbackToClaude: false })
    const before = r.claudeRuntime.sessions.length
    const refused = await collect(r.service.router.startSession(spec({ agentId: r.agent.id })))
    expect(refused.ended?.error).toContain('no fallback')
    expect(r.claudeRuntime.sessions.length).toBe(before)
    expect(r.service.sessionsOfRun(r.run.id).at(-1)).toMatchObject({ outcome: 'refused' })

    // The provider works again: an explicit probe (or a new detection) brings it back.
    r.codexRuntime.script = completeWith({ text: 'codex is back' })
    expect(await r.service.probe('codex')).toMatchObject({ ok: true, status: { health: 'healthy' } })
    // A test is a real session: asked again at once, the last result is given and no second session runs.
    r.codex.probeResult = { ok: false, detail: 'would fail now' }
    expect(await r.service.probe('codex')).toMatchObject({ ok: true })
    expect((await collect(r.service.router.startSession(spec({ agentId: r.agent.id })))).turn?.text).toBe('codex is back')
  })

  it('auth required: the provider is not used, Claude does the review, and the state is visible', async () => {
    const r = rig()
    await r.service.refresh()
    r.service.setPolicy(REVIEW_BY_CODEX)
    r.codex.status = { ...r.codex.status, auth: 'auth_required', health: 'unavailable' }
    await r.service.refresh()
    const out = await collect(r.service.router.startSession(spec({ agentId: r.agent.id })))
    expect(out.turn?.text).toBe('claude says ok')
    expect(r.service.sessionsOfRun(r.run.id).at(-1)?.fallbackReason).toContain('needs authentication')
    expect(r.codexRuntime.sessions).toHaveLength(0)
  })

  it('heterogeneous speculation: candidate B is written by the other provider, candidate A by Claude', async () => {
    const r = rig()
    await r.service.refresh()
    const hetero = { ...DEFAULT_PROVIDER_POLICY, enabled: { claude: true as const, codex: true, gemini: false }, heterogeneousSpeculation: { enabled: true, secondCandidate: 'codex' as const } }
    r.service.setPolicy(hetero)
    const a = await collect(r.service.router.startSession(spec({ agentId: r.agent.id, role: 'worker', label: 'Worker/api · candidate A' })))
    const b = await collect(r.service.router.startSession(spec({ agentId: r.agent.id, role: 'worker', label: 'Worker/api · candidate B' })))
    expect([a.turn?.text, b.turn?.text]).toEqual(['claude says ok', 'codex says ok'])
    expect(r.claudeRuntime.sessions[0]!.cwd).toBe(r.codexRuntime.sessions[0]!.cwd)
    // A provider that may not write cannot be chosen for a candidate.
    r.codex.status = { ...r.codex.status, capabilities: CODEX_CAPABILITIES }
    await r.service.refresh()
    expect(() => r.service.setPolicy(hetero)).toThrow(/read-only/)
  })

  it('a resumed session goes back to the provider that owns it, whatever the policy says now', async () => {
    const r = rig()
    await r.service.refresh()
    r.service.setPolicy(REVIEW_BY_CODEX)
    const first = r.service.router.startSession(spec({ agentId: r.agent.id }))
    await collect(first)
    const sessionId = first.sessionId()!
    r.service.setPolicy({ ...DEFAULT_PROVIDER_POLICY, enabled: { claude: true, codex: true, gemini: false } })
    await collect(r.service.router.resumeSession(spec({ agentId: r.agent.id }), sessionId))
    expect(r.codexRuntime.sessions).toHaveLength(2)
    expect(r.codexRuntime.sessions[1]!.resumeSessionId).toBe(sessionId)
    // Once the user has switched the provider off, its session is not resumed anywhere.
    r.service.setPolicy(DEFAULT_PROVIDER_POLICY)
    const refused = await collect(r.service.router.resumeSession(spec({ agentId: r.agent.id }), sessionId))
    expect(refused.ended?.error).toContain('cannot be resumed')
    expect(r.codexRuntime.sessions).toHaveLength(2)
    expect(r.claudeRuntime.sessions).toHaveLength(0)
  })

  it('one provider failing to answer detection does not fail the others', async () => {
    const r = rig()
    r.codex.discover = async () => {
      throw new Error('boom')
    }
    const statuses = await r.service.refresh()
    expect(statuses.find((s) => s.id === 'claude')?.health).toBeDefined()
    expect(statuses.find((s) => s.id === 'codex')).toMatchObject({ supported: false, health: 'unknown' })
    expect(statuses.find((s) => s.id === 'codex')?.healthDetail).toContain('boom')
  })

  it('migration 008 is additive, and deleting a run removes its provider sessions', () => {
    const old = new BetterSqlite3(':memory:')
    old.pragma('foreign_keys = ON')
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 7))
    const ddl = (d: BetterSqlite3.Database): Map<string, string> => new Map((d.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[]).map((x) => [x.name, x.sql]))
    const earlier = ddl(old)
    runMigrations(old, MIGRATIONS.filter((m) => m.version <= 8))
    const after = ddl(old)
    for (const [name, sql] of earlier) expect(after.get(name), name).toBe(sql)
    expect([...after.keys()].filter((n) => !earlier.has(n) && !n.startsWith('idx_')).sort()).toEqual(['provider_sessions', 'provider_sessions_run_deleted'])
    old.close()
    const r = rig()
    r.service.router.startSession(spec({ agentId: r.agent.id }))
    expect(repos.providerSessions.listByRun(r.run.id)).toHaveLength(1)
    expect(repos.providerSessions.closeInterrupted(new Date().toISOString())).toBe(1)
    expect(repos.providerSessions.listByRun(r.run.id)[0]).toMatchObject({ outcome: 'failed' })
    repos.runs.delete(r.run.id)
    expect(repos.providerSessions.listRecent()).toEqual([])
  })
})

describe('usage isolation between providers', () => {
  it('what a session of another provider reports never moves the Claude usage status or totals', async () => {
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const bus = new EventBus(repos.events, repos.transaction)
    const project = repos.projects.insert(makeProject())
    const run = repos.runs.insert(makeRun(project.id))
    const claudeAgent = repos.agents.insert(makeAgent(run.id, null))
    const codexAgent = repos.agents.insert(makeAgent(run.id, null))
    const claudeRuntime = new FakeAgentRuntime({ script: completeWith({ text: 'ok' }) })
    const service = new ProviderService({
      providers: [new FakeRuntimeProvider('claude', claudeRuntime), new FakeRuntimeProvider('codex', new FakeAgentRuntime({ script: completeWith({ text: 'ok' }) }), {}, 'gpt-fake')],
      sessions: repos.providerSessions,
      settings: repos.settings,
      runOfAgent: (id) => repos.agents.get(id)?.runId ?? null,
    })
    await service.refresh()
    service.setPolicy(REVIEW_BY_CODEX)
    const isOtherProvider = (agentId: string): boolean => {
      const p = repos.providerSessions.latestProviderOfAgent(agentId)
      return p !== null && p !== 'claude'
    }
    const usage = new UsageIntelligenceService({ repos, bus, runtime: service.router, push: () => undefined, isOtherProvider })
    try {
      await collect(service.router.startSession(spec({ agentId: claudeAgent.id, role: 'worker' })))
      await collect(service.router.startSession(spec({ agentId: codexAgent.id, role: 'reviewer' })))
      expect([isOtherProvider(claudeAgent.id), isOtherProvider(codexAgent.id), isOtherProvider('unknown')]).toEqual([false, true, false])
      const turn = (agentId: string): void => {
        bus.emit({ runId: run.id, agentId, type: 'agent.usage', payload: { inputTokens: 0, outputTokens: 0, costUsd: 0, turn: { sdkSessionId: `s-${agentId}`, role: 'reviewer', turns: 1, durationMs: 1000, models: [{ model: 'm', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }] } } })
      }
      // A limit, a failure and tokens reported for the other provider's agent: Claude's picture does not move.
      bus.emit({ runId: run.id, agentId: codexAgent.id, type: 'agent.rate_limited', payload: { status: 'rejected', resetsAt: null, limitType: 'five_hour' } })
      turn(codexAgent.id)
      expect(usage.status()).toBe('AVAILABLE')
      expect(usage.canDispatch()).toBe(true)
      expect(repos.usageEvents.totals().limitEvents).toBe(0)
      const before = repos.usageEvents.totals()
      // The same events for a Claude agent are recorded as before 0.6.
      turn(claudeAgent.id)
      expect(repos.usageEvents.totals()).not.toEqual(before)
      bus.emit({ runId: run.id, agentId: claudeAgent.id, type: 'agent.rate_limited', payload: { status: 'rejected', resetsAt: null, limitType: 'five_hour' } })
      expect(usage.canDispatch()).toBe(false)
    } finally {
      usage.dispose()
      db.close()
    }
  })
})
