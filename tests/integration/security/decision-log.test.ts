import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema } from '@shared/settings'
import { ipcInputs } from '@shared/ipc'
import { SECURITY_POLICY_VERSION, type SecurityDecisionRecord } from '@shared/security'
import { createSecurityHandlers } from '@main/modules/ipc/v7-security-handlers'
import { dispatchIpc } from '@main/modules/ipc/handlers'
import { MAX_DECISIONS_PER_RUN } from '@main/modules/persistence/repositories/security'
import { ProvenanceTracker, toolsForRole } from '@main/modules/policies'
import { openMemory } from '../persistence/fixtures'

const row = (n: number, over: Partial<Omit<SecurityDecisionRecord, 'seq'>> = {}): Omit<SecurityDecisionRecord, 'seq'> => ({
  id: `id-${n}`,
  timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  runId: 'run-1',
  taskId: 'task-1',
  agentId: 'agent-1',
  action: `command ${n}`,
  classification: 'UNTRUSTED_AGENT_AUTHORED',
  provenance: 'agent_authored',
  decision: 'DENY',
  reason: 'because',
  policyVersion: SECURITY_POLICY_VERSION,
  ...over,
})

describe('security decision log', () => {
  it('migration 011 creates the tables and the repository round-trips a decision', () => {
    const { repos } = openMemory()
    repos.securityDecisions.record(row(1))
    const page = repos.securityDecisions.list()
    expect(page.decisions).toHaveLength(1)
    expect(page.decisions[0]).toMatchObject({ id: 'id-1', decision: 'DENY', classification: 'UNTRUSTED_AGENT_AUTHORED', provenance: 'agent_authored', runId: 'run-1', policyVersion: SECURITY_POLICY_VERSION })
    expect(page.nextBefore).toBeNull()
  })

  it('pages newest first with a cursor, filters by run and caps the page size', () => {
    const { repos } = openMemory()
    for (let i = 1; i <= 30; i++) repos.securityDecisions.record(row(i, { runId: i % 2 === 0 ? 'run-even' : 'run-odd' }))
    const first = repos.securityDecisions.list({ limit: 10 })
    expect(first.decisions.map((d) => d.id)).toEqual(Array.from({ length: 10 }, (_, k) => `id-${30 - k}`))
    expect(first.nextBefore).not.toBeNull()
    const second = repos.securityDecisions.list({ limit: 10, before: first.nextBefore ?? 0 })
    expect(second.decisions[0]?.id).toBe('id-20')
    const even = repos.securityDecisions.list({ runId: 'run-even', limit: 200 })
    expect(even.decisions).toHaveLength(15)
    expect(even.decisions.every((d) => d.runId === 'run-even')).toBe(true)
    expect(even.nextBefore).toBeNull()
    expect(repos.securityDecisions.list({ limit: 100_000 }).decisions.length).toBeLessThanOrEqual(200)
  })

  it('is bounded: the oldest rows of a run are pruned as new ones arrive', () => {
    const { repos } = openMemory()
    const n = MAX_DECISIONS_PER_RUN + 60
    for (let i = 1; i <= n; i++) repos.securityDecisions.record(row(i))
    expect(repos.securityDecisions.count('run-1')).toBeLessThanOrEqual(MAX_DECISIONS_PER_RUN + 25)
    expect(repos.securityDecisions.count('run-1')).toBeGreaterThan(MAX_DECISIONS_PER_RUN - 1)
    const newest = repos.securityDecisions.list({ limit: 1 }).decisions[0]
    expect(newest?.id).toBe(`id-${n}`)
  })

  it('is reachable through the IPC channel with the input schema enforced', async () => {
    const { repos } = openMemory()
    for (let i = 1; i <= 5; i++) repos.securityDecisions.record(row(i))
    const handlers = { ...createSecurityHandlers(repos) } as unknown as Parameters<typeof dispatchIpc>[0]
    const ok = await dispatchIpc(handlers, 'security.decisions', { runId: 'run-1', limit: 2 })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      const page = ok.value as { decisions: unknown[]; nextBefore: number | null }
      expect(page.decisions).toHaveLength(2)
      expect(page.nextBefore).not.toBeNull()
    }
    for (const bad of [{ limit: 201 }, { limit: 0 }, { limit: 1.5 }, { before: 0 }, { runId: '' }, { runId: 'x'.repeat(200) }, { extra: 1 }, { limit: '5' }]) {
      const r = await dispatchIpc(handlers, 'security.decisions', bad)
      expect(r.ok, JSON.stringify(bad)).toBe(false)
    }
    expect(ipcInputs['security.decisions'].safeParse({}).success).toBe(true)
  })

  it('exposes only reads: the only security.* channel is the paged decision list', () => {
    expect(Object.keys(ipcInputs).filter((c) => c.startsWith('security.'))).toEqual(['security.decisions'])
  })
})

describe('file provenance persistence', () => {
  it('survives a restart: a new tracker over the same store still knows who wrote the file', () => {
    const { repos } = openMemory()
    const first = new ProvenanceTracker(repos.fileProvenance)
    const wt = path.resolve('C:\\work\\wt-persist')
    first.recordWrite(path.join(wt, 'a.ps1'), wt, { agentId: 'agent-1', taskId: 't', runId: 'r' }, 'Write-Host hi')
    const second = new ProvenanceTracker(repos.fileProvenance)
    const rec = second.recorded(path.join(wt, 'a.ps1'), wt)
    expect(rec?.createdByAgentId).toBe('agent-1')
    expect(rec?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rec?.trust).toBe('UNTRUSTED_AGENT_AUTHORED')
    // Case-insensitive on Windows, like the file system.
    if (process.platform === 'win32') expect(second.recorded(path.join(wt, 'A.PS1'), wt)).not.toBeNull()
  })

  it('keeps first-seen and creator when a second agent modifies the file', () => {
    const { repos } = openMemory()
    const t = new ProvenanceTracker(repos.fileProvenance)
    const wt = path.resolve('C:\\work\\wt-two')
    const f = path.join(wt, 'x.js')
    t.recordWrite(f, wt, { agentId: 'a1', taskId: null, runId: null })
    t.recordWrite(f, wt, { agentId: 'a2', taskId: null, runId: null })
    const rec = new ProvenanceTracker(repos.fileProvenance).recorded(f, wt)
    expect(rec?.createdByAgentId).toBe('a1')
    expect(rec?.modifiedByAgentId).toBe('a2')
  })
})

describe('execution profile setting', () => {
  it('defaults to STANDARD and old stored settings (without the field) still parse', () => {
    expect(DEFAULT_SETTINGS.execution.profile).toBe('STANDARD')
    const old = structuredClone(DEFAULT_SETTINGS) as unknown as { execution: Record<string, unknown> }
    delete old.execution.profile
    const parsed = SettingsSchema.safeParse(old)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.execution.profile).toBe('STANDARD')
  })

  it('round-trips RESTRICTED through the settings repository and rejects anything else', () => {
    const { repos } = openMemory()
    const next = { ...repos.settings.get(), execution: { ...repos.settings.get().execution, profile: 'RESTRICTED' as const } }
    repos.settings.set(next)
    expect(repos.settings.get().execution.profile).toBe('RESTRICTED')
    expect(SettingsSchema.safeParse({ ...next, execution: { ...next.execution, profile: 'SANDBOX' } }).success).toBe(false)
  })
})

describe('power boundary', () => {
  const root = path.resolve(import.meta.dirname, '../../../src/main')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  const imports = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')
  const reachesPower = (spec: string): boolean => /(^|\/)power(\/|$)|power-controller/.test(spec)

  it('nothing on the agent path imports the power controller', () => {
    const agentPath = ['policies', 'agent-runtime', 'orchestrator', 'providers', 'context', 'git', 'planning', 'memory', 'routing', 'strategy', 'state', 'events']
    const offenders: string[] = []
    for (const dir of agentPath) {
      const full = path.join(root, 'modules', dir)
      if (!existsSync(full)) continue
      for (const f of walk(full)) if (imports(f).some(reachesPower)) offenders.push(path.relative(root, f))
    }
    expect(offenders).toEqual([])
  })

  it('only the overnight supervisor and the process entry points import it, and the IPC handlers do not', () => {
    const importers = walk(root)
      .filter((f) => !f.includes(`${path.sep}power${path.sep}`))
      .filter((f) => imports(f).some(reachesPower))
      .map((f) => path.relative(root, f).replace(/\\/g, '/'))
      .sort()
    for (const f of importers) expect(['modules/overnight/supervisor.ts', 'runtime/core.ts', 'index.ts', 'worker.ts'], f).toContain(f)
    for (const f of walk(path.join(root, 'modules', 'ipc'))) expect(imports(f).some(reachesPower), f).toBe(false)
  })

  it('no tool an agent is given is named after power', () => {
    for (const role of ['worker', 'debugger', 'reviewer', 'verifier', 'planner', 'architect', 'researcher', 'security_reviewer'] as const) {
      for (const t of toolsForRole(role, { allowNetworkTools: true })) expect(t.toLowerCase()).not.toMatch(/power(?!shell)|shutdown|restart/)
    }
  })
})
