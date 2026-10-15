import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdvisoryProvider } from '@main/modules/intelligence/compiler'
import type { BrokerExecRequest, BrokerExecResult } from '@main/modules/privilege/broker-client'
import { PrivilegedPolicyEngine } from '@main/modules/privilege/policy'
import { buildPrivilegedActivityReport, buildPrivilegedActivitySummary } from '@main/modules/privilege/report'
import { PrivilegedReviewPipeline } from '@main/modules/privilege/review'
import { PrivilegeService, type BrokerHandle, type PrivilegedRequester } from '@main/modules/privilege/service'
import { MemoryPrivilegeStore } from '@main/modules/privilege/store'
import { PRIVILEGED_CAPABILITIES, PrivilegedOperationProposalSchema, type PrivilegedOperationProposal } from '@shared/privilege'

// 0.9.1: privilege sessions with a scripted broker and scripted reviewers. The broker's own protocol and checks are
// tested against the real helper in tests/integration/privilege.

const fixtureDir = resolve(__dirname, '..', '..', '..', 'native', 'privilege-fixture')
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const HEAD = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

class FakeBroker implements BrokerHandle {
  alive = true
  elevated = true
  ran: BrokerExecRequest[] = []
  ended = false
  constructor(private readonly answer: (req: BrokerExecRequest, n: number) => BrokerExecResult) {}
  async exec(req: BrokerExecRequest): Promise<BrokerExecResult> {
    this.ran.push(req)
    return this.answer(req, this.ran.length)
  }
  async end(): Promise<void> {
    this.ended = true
    this.alive = false
  }
}

const ok = (stdout = 'done', exitCode = 0): BrokerExecResult => ({ kind: 'result', exitCode, durationMs: 120, timedOut: false, executable: PS, stagedSha256: null, leftoverEnded: 0, leftover: null, stdout, stderr: exitCode === 0 ? '' : 'the folder is missing', stdoutTruncated: false, stderrTruncated: false })

function reviewer(verdict: 'APPROVE' | 'REJECT' = 'APPROVE', calls: { n: number } = { n: 0 }): AdvisoryProvider {
  return {
    complete: async () => {
      calls.n++
      return { verdict, risk: 'LOW', reason: verdict === 'APPROVE' ? 'Narrow and reversible.' : 'Not needed.', restrictions: [] }
    },
  }
}

function setup(opts: { broker?: FakeBroker; technical?: AdvisoryProvider; strategic?: AdvisoryProvider; decline?: boolean; owner?: (o: { title: string; message: string; detail: string }) => Promise<boolean>; store?: MemoryPrivilegeStore; blocked?: (runId: string | null) => string | null } = {}) {
  const store = opts.store ?? new MemoryPrivilegeStore()
  const broker = opts.broker ?? new FakeBroker((req, n) => (req.args[5]?.endsWith('fixture-install.ps1') && n === 1 ? ok('', 3) : ok()))
  let uac = 0
  const service: PrivilegeService = new PrivilegeService({
    store,
    policy: new PrivilegedPolicyEngine(() => ({
      systemRoot: 'C:\\Windows',
      programFiles: 'C:\\Program Files',
      programFilesX86: 'C:\\Program Files (x86)',
      nexusScriptsDir: null,
      fixtureDir,
      trustedHash: (p) => sha(p),
      projectRoots: ['C:\\work\\racedeck'],
      sessionCapabilities: service.sessionCapabilities(),
    })),
    review: new PrivilegedReviewPipeline({ providers: async () => ({ technical: opts.technical ?? reviewer(), ...(opts.strategic ? { strategic: opts.strategic } : {}) }) }),
    startBroker: async () => {
      uac++
      if (opts.decline) return { ok: false, outcome: 'DECLINED', reason: 'The administrator prompt was declined.' }
      return { ok: true, client: broker }
    },
    verify: async (req) => req.expected.files.map((f) => `${f}: present.`),
    ...(opts.owner ? { confirmOwner: opts.owner } : {}),
    ...(opts.blocked ? { blockedBy: opts.blocked } : {}),
  })
  return { service, store, broker, uac: () => uac }
}

const who = (over: Partial<PrivilegedRequester> = {}): PrivilegedRequester => ({ projectId: 'p1', runId: 'run-1', taskId: 'task-1', agentId: 'agent-1', role: 'WORKER', missionTitle: 'RaceDeck telemetry', taskTitle: 'Install the fixture tool', provenance: 'agent tool call (worker)', ...over })

const fixture = (name: string, extra: string[] = [], over: Partial<PrivilegedOperationProposal> = {}): PrivilegedOperationProposal =>
  PrivilegedOperationProposalSchema.parse({
    capability: 'NEXUS_ACCEPTANCE_FIXTURE',
    goal: `Run ${name}`,
    whyRequired: 'The build needs the fixture tool.',
    whyElevation: 'It writes under Program Files.',
    whyNoUnelevatedAlternative: 'Program Files is writable by administrators only.',
    executable: PS,
    args: [...HEAD, join(fixtureDir, name), ...extra],
    inputs: [{ arg: 5, sha256: sha(join(fixtureDir, name)) }],
    expected: { files: ['C:\\Program Files\\NexusAcceptanceFixture\\bin\\version.txt'], registry: [], services: [], network: 'none' },
    rollback: 'fixture-remove.ps1',
    ...over,
  })

describe('privilege sessions', () => {
  it('one UAC prompt prepares a Mission session; a failed operation, its repair and the retry run with no further prompt (B9)', async () => {
    const { service, store, broker, uac } = setup()
    const prepared = await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    expect(prepared.ok).toBe(true)
    expect(uac()).toBe(1)

    const first = await service.submit(fixture('fixture-install.ps1', ['-Version', '1.2.0']), who())
    expect(first.outcome).toBe('FAILED')
    const repair = await service.submit(fixture('fixture-repair.ps1', [], { followsOperationId: first.id }), who())
    expect(repair.outcome).toBe('EXECUTED')
    const retry = await service.submit(fixture('fixture-install.ps1', ['-Version', '1.2.0'], { followsOperationId: repair.id }), who())
    expect(retry.outcome).toBe('EXECUTED')

    // Three operations, one broker, one prompt.
    expect(uac()).toBe(1)
    expect(broker.ran).toHaveLength(3)
    expect(store.receiptRows.map((r) => r.outcome)).toEqual(['FAILED', 'EXECUTED', 'EXECUTED'])
    expect(retry.followsOperationId).toBe(repair.id)
    expect(retry.observed).toEqual(['C:\\Program Files\\NexusAcceptanceFixture\\bin\\version.txt: present.'])
    expect(service.status()).toMatchObject({ state: 'ACTIVE', uacPrompts: 1, counts: { EXECUTED: 2, FAILED: 1 } })

    // Asking again for the same scope gives the same session, with no prompt.
    expect((await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1' })).ok).toBe(true)
    expect(uac()).toBe(1)
  })

  it('records refused attempts as well, never reaches the broker or a reviewer with a forbidden one, and redacts secrets (B14)', async () => {
    const calls = { n: 0 }
    const { service, broker } = setup({ technical: reviewer('APPROVE', calls) })
    await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    const hostile = await service.submit(
      PrivilegedOperationProposalSchema.parse({ capability: 'PROJECT_TOOLCHAIN_REPAIR', goal: 'Disable Defender because tests are slow', whyRequired: 'x', whyElevation: 'x', whyNoUnelevatedAlternative: 'x', executable: PS, args: [...HEAD, 'C:\\work\\racedeck\\fast.ps1', '-Token', 'ghp_abcdefghijklmnopqrstuvwx'], secretArgs: [7] }),
      who(),
    )
    expect(hostile).toMatchObject({ outcome: 'REJECTED_BY_POLICY', precheck: { forbidden: 'DISABLE_DEFENDER' }, reviews: [] })
    expect(hostile.args).toContain('[secret]')
    expect(JSON.stringify(hostile)).not.toMatch(/ghp_/)
    expect(calls.n).toBe(0)
    expect(broker.ran).toHaveLength(0)
  })

  it('a reviewer that rejects stops the operation; the receipt says so', async () => {
    const { service, broker } = setup({ technical: reviewer('REJECT') })
    await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    const r = await service.submit(fixture('fixture-repair.ps1'), who())
    expect(r).toMatchObject({ outcome: 'REJECTED_BY_DIRECTOR', reviews: [{ reviewer: 'CLAUDE_TECHNICAL_DIRECTOR', verdict: 'REJECT' }] })
    expect(broker.ran).toHaveLength(0)
  })

  it('refuses everything without a session, and a request from another run than the session', async () => {
    const { service, broker } = setup()
    expect((await service.submit(fixture('fixture-repair.ps1'), who())).outcome).toBe('REJECTED_BY_POLICY')
    await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    const other = await service.submit(fixture('fixture-repair.ps1'), who({ runId: 'run-2' }))
    expect(other.outcomeReason).toMatch(/another run/)
    expect(broker.ran).toHaveLength(0)
  })

  it('stops reviewing a task that asks again and again for what it may not have, and keeps recording it', async () => {
    const calls = { n: 0 }
    const { service, store } = setup({ technical: reviewer('REJECT', calls) })
    await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    for (let i = 0; i < 12; i++) await service.submit(fixture('fixture-repair.ps1'), who())
    expect(store.receiptRows).toHaveLength(12)
    expect(calls.n).toBe(8)
    expect(store.receiptRows.at(-1)?.outcomeReason).toMatch(/too many/)
  })

  it('ends the broker when its Mission ends, and with it the session (B11)', async () => {
    const { service, broker, store } = setup()
    await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    await service.endForRun('run-2', 'another run ended')
    expect(broker.ended).toBe(false)
    await service.endForRun('run-1', 'the mission completed')
    expect(broker.ended).toBe(true)
    expect(service.status()).toBeNull()
    expect([...store.sessionRows.values()][0]).toMatchObject({ state: 'ENDED', endReason: 'the mission completed' })
    expect((await service.submit(fixture('fixture-repair.ps1'), who())).outcome).toBe('REJECTED_BY_POLICY')
  })

  it('a broker that goes away ends the session; an operation in flight is ABORTED', async () => {
    let lost: (reason: string) => void = () => undefined
    const store = new MemoryPrivilegeStore()
    const broker = new FakeBroker(() => {
      broker.alive = false
      lost('the relay ended')
      return { kind: 'lost', reason: 'the relay ended' }
    })
    const service: PrivilegeService = new PrivilegeService({
      store,
      policy: new PrivilegedPolicyEngine(() => ({ systemRoot: 'C:\\Windows', programFiles: 'C:\\Program Files', programFilesX86: 'C:\\Program Files (x86)', nexusScriptsDir: null, fixtureDir, trustedHash: sha, projectRoots: [], sessionCapabilities: service.sessionCapabilities() })),
      review: new PrivilegedReviewPipeline({ providers: async () => ({ technical: reviewer() }) }),
      startBroker: async (o) => {
        lost = o.onEnded
        return { ok: true, client: broker }
      },
    })
    await service.prepare({ scope: 'OVERNIGHT', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    const r = await service.submit(fixture('fixture-repair.ps1'), who())
    expect(r.outcome).toBe('ABORTED')
    expect(service.status()).toBeNull()
    expect([...store.sessionRows.values()][0]?.state).toBe('ENDED')
  })

  it('a declined prompt leaves no session, and a restart closes what a previous runtime left open', async () => {
    const { service, store, uac } = setup({ decline: true })
    const r = await service.prepare({ scope: 'OVERNIGHT', runId: 'run-1', projectId: 'p1' })
    expect(r).toMatchObject({ ok: false, reason: 'The administrator prompt was declined.' })
    expect(uac()).toBe(1)
    expect([...store.sessionRows.values()][0]?.state).toBe('DECLINED')
    const declined = [...store.sessionRows.values()][0]
    if (declined === undefined) throw new Error('no session')
    store.saveSession({ ...declined, id: 'left-open', state: 'ACTIVE' })
    service.recover()
    expect(store.session('left-open')).toMatchObject({ state: 'ENDED', endReason: 'NEXUS stopped; the broker ended with it' })
  })

  it('a single-operation session ends after its operation', async () => {
    const { service, broker } = setup({ broker: new FakeBroker(() => ok()) })
    await service.prepare({ scope: 'SINGLE_OPERATION', runId: null, projectId: null, capabilities: [...PRIVILEGED_CAPABILITIES] })
    expect((await service.submit(fixture('fixture-repair.ps1'), who())).outcome).toBe('EXECUTED')
    expect(broker.ended).toBe(true)
    expect(service.status()).toBeNull()
  })

  it('asks the Council only when the template says so, and not for a rejected operation', async () => {
    const strategicCalls = { n: 0 }
    const { service, broker } = setup({ broker: new FakeBroker(() => ok()), strategic: reviewer('APPROVE', strategicCalls), owner: async () => true })
    await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    await service.submit(fixture('fixture-repair.ps1'), who())
    expect(strategicCalls.n).toBe(0)
    const install = await service.submit(
      PrivilegedOperationProposalSchema.parse({ capability: 'KNOWN_DEPENDENCY_MACHINE_INSTALL', goal: 'Install the Visual C++ runtime', whyRequired: 'The native module loads it.', whyElevation: 'Machine-wide runtime.', whyNoUnelevatedAlternative: 'There is no per-user package.', executable: 'C:\\Windows\\System32\\msiexec.exe', args: ['/i', 'C:\\work\\racedeck\\vc.msi', '/qn'], inputs: [{ arg: 1, sha256: 'c'.repeat(64) }] }),
      who(),
    )
    expect(strategicCalls.n).toBe(1)
    expect(install.reviews.map((r) => r.reviewer)).toEqual(['CLAUDE_TECHNICAL_DIRECTOR', 'DIRECTOR_COUNCIL'])
    expect(broker.ran).toHaveLength(2)
  })

  // 0.9.1 (review F3): a package the run may have fetched runs only once the owner confirmed it, whatever the reviews.
  it('runs a file NEXUS does not ship only when the owner confirms this very operation', async () => {
    const msi = PrivilegedOperationProposalSchema.parse({ capability: 'KNOWN_DEPENDENCY_MACHINE_INSTALL', goal: 'Install the Visual C++ runtime', whyRequired: 'The native module loads it.', whyElevation: 'Machine-wide runtime.', whyNoUnelevatedAlternative: 'There is no per-user package.', executable: 'C:\\Windows\\System32\\msiexec.exe', args: ['/i', 'C:\\work\\racedeck\\vc.msi', '/qn'], inputs: [{ arg: 1, sha256: 'c'.repeat(64) }] })
    const asked: string[] = []
    const no = setup({ broker: new FakeBroker(() => ok()), strategic: reviewer('APPROVE'), owner: async (o) => (asked.push(o.detail), false) })
    await no.service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    const declined = await no.service.submit(msi, who())
    expect(declined.outcome).toBe('DECLINED_BY_OWNER')
    expect(no.broker.ran).toHaveLength(0)
    expect(asked[0]).toContain('msiexec.exe /i C:\\work\\racedeck\\vc.msi /qn')
    expect(asked[0]).toContain('it installs the package vc.msi')
    // With no way to ask, nothing runs.
    const none = setup({ broker: new FakeBroker(() => ok()), strategic: reviewer('APPROVE') })
    await none.service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    expect((await none.service.submit(msi, who())).outcome).toBe('DECLINED_BY_OWNER')
    expect(none.broker.ran).toHaveLength(0)
    // A script NEXUS ships does not ask.
    await no.service.submit(fixture('fixture-repair.ps1'), who())
    expect(asked).toHaveLength(1)
    expect(no.broker.ran).toHaveLength(1)
  })

  // 0.9.1 (review F6, F12): on record before it starts; secrets given to it removed from what it printed.
  it('records an operation before it runs, closes one a stopped NEXUS left running, and removes the secrets it was given from its output', async () => {
    const store = new MemoryPrivilegeStore()
    let during: string[] = []
    const broker = new FakeBroker(() => {
      during = store.receiptRows.map((r) => r.outcome)
      return ok('licence accepted: K7Q2-PLM9-ZZ41 for user hunter2go')
    })
    const { service } = setup({ broker, store })
    await service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    // 0.9.1 (second review, M4): only a value that says it is a secret may be hidden from the reviewers and the owner.
    const hidden = await service.submit(fixture('fixture-repair.ps1', [], { args: [...HEAD, join(fixtureDir, 'fixture-repair.ps1'), '-Version', 'hunter2go'], secretArgs: [7] }), who())
    expect(hidden).toMatchObject({ outcome: 'REJECTED_BY_POLICY', outcomeReason: expect.stringMatching(/NAME=value/) })
    store.receiptRows.length = 0
    const r = await service.submit(fixture('fixture-repair.ps1', [], { env: { LICENCE_KEY: 'K7Q2-PLM9-ZZ41', OWNER_NAME: 'hunter2go' } }), who())
    expect(during).toEqual(['EXECUTING'])
    expect(r.outcome).toBe('EXECUTED')
    expect(store.receiptRows).toHaveLength(1)
    expect(r.stdout).toBe('licence accepted: [secret] for user [secret]')
    // A NEXUS that stopped while an operation ran: at the next start it is closed, not left as running.
    store.record({ ...r, id: 'op-crashed', outcome: 'EXECUTING' })
    setup({ store }).service.recover()
    expect(store.receiptRows.find((x) => x.id === 'op-crashed')).toMatchObject({ outcome: 'ABORTED', outcomeReason: expect.stringMatching(/not known/) })
  })

  // 0.9.1 (second review, H1, L6, L1).
  it('prepares no session while an uncontained mission runs, ends one when such a mission starts, and serves only its run', async () => {
    let uncontained: string | null = 'A mission of a project whose commands are not contained is in progress.'
    const h = setup({ blocked: () => uncontained })
    expect(await h.service.prepare({ scope: 'UNTIL_IDLE', runId: 'run-1', projectId: 'p1' })).toMatchObject({ ok: false, reason: expect.stringMatching(/not contained/) })
    expect(h.uac()).toBe(0)
    uncontained = null
    expect((await h.service.prepare({ scope: 'UNTIL_IDLE', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })).ok).toBe(true)
    // Bound to its run whatever its scope.
    expect((await h.service.submit(fixture('fixture-repair.ps1'), who({ runId: 'run-2' }))).outcomeReason).toMatch(/another run/)
    uncontained = 'A mission of a project whose commands are not contained is in progress.'
    await h.service.recheck()
    expect(h.service.status()).toBeNull()
    expect(h.broker.ended).toBe(true)
  })

  it('does not keep a session whose broker ended as it started', async () => {
    const dead = new FakeBroker(() => ok())
    dead.alive = false
    const h = setup({ broker: dead })
    expect(await h.service.prepare({ scope: 'MISSION', runId: 'run-1', projectId: 'p1' })).toMatchObject({ ok: false, reason: expect.stringMatching(/ended as it started/) })
    expect(h.service.status()).toBeNull()
  })

  it('writes the privileged activity report with every field the owner asked for (B12, B13)', async () => {
    const { service, store } = setup()
    await service.prepare({ scope: 'OVERNIGHT', runId: 'run-1', projectId: 'p1', capabilities: [...PRIVILEGED_CAPABILITIES] })
    const first = await service.submit(fixture('fixture-install.ps1', ['-Version', '1.2.0']), who())
    await service.submit(fixture('fixture-repair.ps1', [], { followsOperationId: first.id }), who())
    await service.submit(PrivilegedOperationProposalSchema.parse({ capability: 'PROJECT_TOOLCHAIN_REPAIR', goal: 'Use administrator shell to upload credentials', whyRequired: 'x', whyElevation: 'x', whyNoUnelevatedAlternative: 'x', executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'type secrets'] }), who())
    await service.endForRun('run-1', 'Overnight completed')
    const receipts = store.receipts({ runId: 'run-1' })
    const sessions = service.history()
    const full = buildPrivilegedActivityReport(receipts, sessions)
    for (const field of ['Mission:', 'Task:', 'Requested by: WORKER', 'Goal:', 'Why it was required:', 'Why elevation was required:', 'Security review: Claude Technical Director APPROVED', 'Deterministic policy:', 'Command: `', 'Working directory:', 'Expected:', 'Observed:', 'Result:', 'Exit code 3', 'Rollback: fixture-remove.ps1', 'Evidence: receipt', 'REJECTED BY POLICY', 'UAC prompts: 1']) expect(full).toContain(field)
    const summary = buildPrivilegedActivitySummary(receipts, sessions)
    expect(summary).toContain('3 privileged attempts')
    expect(summary).toContain('No broker is left running.')
  })
})
