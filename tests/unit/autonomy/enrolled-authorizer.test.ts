import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AUTONOMY_POLICY_VERSION, capabilityKind, type AutonomyAuditEvent, type AutonomyProfile, type BoundaryRequest, type CapabilityGrant } from '@shared/autonomy'
import type { AgentRole } from '@shared/domain'
import { CapabilityBroker } from '@main/modules/autonomy/broker'
import { createAutonomyGate } from '@main/modules/autonomy/gate'
import { BASE_FILES, CORPUS, type CorpusCase } from '../../fixtures/adversarial-corpus'
import { REVIEW_CASES } from '../../fixtures/adversarial-corpus-review'
import { REVIEW2_CASES } from '../../fixtures/adversarial-corpus-review2'
import { REVIEW3_CASES } from '../../fixtures/adversarial-corpus-review3'
import { createFixtureRepo, git, type FixtureRepo } from '../../fixtures/malicious-repos'

// 0.8: the same policy, for a project the user enrolled. The capability broker stands where the approval
// dialog stood. Two properties are pinned over the whole 0.7 corpus: an enrolled project never produces an
// approval request, and nothing the policy refused outright is allowed because the project is enrolled.

let repo: FixtureRepo

beforeAll(() => {
  repo = createFixtureRepo(BASE_FILES)
  mkdirSync(path.join(repo.root, 'node_modules', '.bin'), { recursive: true })
  for (const tool of ['vitest', 'tsc', 'eslint']) writeFileSync(path.join(repo.root, 'node_modules', '.bin', `${tool}.cmd`), '@echo off\r\n')
})
afterAll(() => repo.cleanup())
afterEach(() => {
  git(repo.root, 'checkout', '-q', '--', '.')
  git(repo.root, 'clean', '-fdq')
  repo.decisions.length = 0
})

function enrolled(profile: AutonomyProfile, contained: boolean) {
  const grants: CapabilityGrant[] = []
  const requests: BoundaryRequest[] = []
  const audit: Omit<AutonomyAuditEvent, 'seq'>[] = []
  const broker = new CapabilityBroker({
    enrollment: (projectId) => ({ projectId, profile, enrolledAt: '2026-10-11T09:00:00Z', policyVersion: AUTONOMY_POLICY_VERSION }),
    grants: {
      insert: (g) => void grants.push({ ...g }),
      listUsable: () => grants.filter((g) => g.revokedAt === null && g.consumedAt === null),
      consume: (id, at) => {
        const g = grants.find((x) => x.id === id)
        if (!g || g.consumedAt !== null) return false
        g.consumedAt = at
        return true
      },
      revoke: () => false,
      get: (id) => grants.find((x) => x.id === id) ?? null,
    },
    requests: {
      insert: (r) => void requests.push({ ...r }),
      findByKey: (key) => [...requests].reverse().find((r) => r.dedupeKey === key) ?? null,
      touch: (id) => {
        const r = requests.find((x) => x.id === id)
        if (r) r.occurrences += 1
      },
      decide: (id, state, at, scope, grantId) => {
        const r = requests.find((x) => x.id === id)
        if (!r || r.state !== 'PENDING') return false
        Object.assign(r, { state, decidedAt: at, decidedScope: scope, grantId })
        return true
      },
      get: (id) => requests.find((x) => x.id === id) ?? null,
      listPending: () => requests.filter((r) => r.state === 'PENDING'),
    },
    runActive: () => true,
    audit: (e) => void audit.push(e),
    transaction: (fn) => fn(),
  })
  const authorize = (role: AgentRole, toolName: string, input: Record<string, unknown>) =>
    repo.authorize(role, toolName, input, { autonomy: createAutonomyGate({ broker, projectId: 'p1', runId: 'run-1', taskId: 'task-1', role, provider: 'claude', cwd: repo.root, contained }) })
  return { broker, grants, requests, audit, authorize }
}

const ALL: CorpusCase[] = [...CORPUS, ...REVIEW_CASES, ...REVIEW2_CASES, ...REVIEW3_CASES].filter((c) => (c.profile ?? 'STANDARD') === 'STANDARD')

/** One pass over the corpus: the decision of every case, with the files of a case put back only where it wrote some. */
async function runCorpus(contained: boolean) {
  const h = enrolled('AUTONOMOUS_PROJECT', contained)
  const results: { c: CorpusCase; behavior: string; detail: string }[] = []
  for (const c of ALL) {
    const files = Object.entries(c.agent ?? {})
    for (const [rel, content] of files) repo.write(rel, content)
    const d = await h.authorize(c.role ?? 'worker', c.shell ?? 'Bash', { command: c.command })
    results.push({ c, behavior: d.behavior, detail: `${c.id}: ${c.command} -> ${JSON.stringify(d)}` })
    if (files.length > 0) {
      git(repo.root, 'checkout', '-q', '--', '.')
      git(repo.root, 'clean', '-fdq')
    }
  }
  return { h, results }
}

describe('the 0.7 corpus in an enrolled project', () => {
  for (const contained of [true, false]) {
    it(
      `contained=${contained}: never asks the user, allows nothing the policy refuses outright, keeps allowing what it allowed`,
      async () => {
        const { h, results } = await runCorpus(contained)
        for (const r of results) {
          expect(r.behavior, r.detail).not.toBe('ask')
          if (r.c.expect === 'deny') expect(r.behavior, r.detail).toBe('deny')
          if (r.c.expect === 'allow') expect(r.behavior, r.detail).toBe('allow')
        }
        // A refusal of the policy is never a question for the user either.
        expect(h.requests.filter((r) => capabilityKind(r.capability) === 'NEVER')).toEqual([])
        const asks = results.filter((r) => r.c.expect === 'ask')
        expect(asks.length).toBeGreaterThan(20)
        if (!contained) {
          // Outside the containment, what the policy could only ask about is refused and becomes a question:
          // many commands, few questions, because a question is per capability and resource, not per command.
          for (const r of asks) expect(r.behavior, r.detail).toBe('deny')
          expect(h.requests.length).toBeGreaterThan(0)
          expect(h.requests.length).toBeLessThan(asks.length / 2)
        }
      },
      480_000,
    )
  }
})

describe('ordinary work in an enrolled, contained project', () => {
  it('runs a working day of commands with no boundary request at all', async () => {
    const h = enrolled('AUTONOMOUS_PROJECT', true)
    repo.write('scripts/gen.js', "require('fs').writeFileSync('out.txt', 'x')\n")
    repo.write('scratch/build/a.txt', 'x')
    const day: [string, string][] = [
      ['Bash', 'git status'],
      ['Bash', 'pnpm install'],
      ['Bash', 'pnpm test'],
      ['Bash', 'pnpm build'],
      ['Bash', 'node scripts/gen.js'],
      ['Bash', 'node -e "console.log(1+1)"'],
      ['Bash', 'rm -rf scratch'],
      ['PowerShell', 'Remove-Item -Recurse -Force node_modules/.cache'],
      ['Bash', 'git add -A && git commit -m "work"'],
      ['Bash', 'git reset --hard HEAD'],
      ['Bash', 'npx vitest run'],
      ['Bash', 'mkdir -p out && echo done > out/log.txt'],
    ]
    for (let round = 0; round < 5; round += 1) {
      for (const [tool, command] of day) {
        const d = await h.authorize('worker', tool, { command })
        expect(d.behavior, `${command} -> ${JSON.stringify(d)}`).toBe('allow')
      }
    }
    expect(h.requests).toEqual([])
    expect(h.audit.every((e) => e.severity === 'NORMAL_AUTONOMOUS_ACTION')).toBe(true)
  })

  it('makes one request for a push however often it is tried, and refuses each try with the request named', async () => {
    const h = enrolled('AUTONOMOUS_PROJECT', true)
    for (let i = 0; i < 12; i += 1) {
      const d = await h.authorize('worker', 'Bash', { command: 'git push origin HEAD' })
      expect(d.behavior).toBe('deny')
      if (d.behavior === 'deny') expect(d.reason).toContain(`boundary request ${h.requests[0]?.id}`)
    }
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({ capability: 'GIT_PUSH', state: 'PENDING', occurrences: 12 })
    h.broker.resolve({ requestId: h.requests[0]?.id ?? '', decision: 'ALLOW_MISSION' })
    expect((await h.authorize('worker', 'Bash', { command: 'git push origin HEAD' })).behavior).toBe('allow')
  })

  it('makes a write outside the task roots a boundary request for that path, and lets it through once granted', async () => {
    const h = enrolled('AUTONOMOUS_PROJECT', true)
    const target = path.join(repo.outside, 'notes.txt')
    const first = await h.authorize('worker', 'Write', { file_path: target, content: 'x' })
    expect(first.behavior).toBe('deny')
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({ capability: 'WRITE_OUTSIDE_PROJECT', resource: { kind: 'PATH' } })
    await h.authorize('worker', 'Write', { file_path: target, content: 'x' })
    expect(h.requests).toHaveLength(1)
    h.broker.resolve({ requestId: h.requests[0]?.id ?? '', decision: 'ALLOW_PROJECT' })
    expect((await h.authorize('worker', 'Write', { file_path: target, content: 'x' })).behavior).toBe('allow')
    // The grant is for that path: its neighbour is another question.
    expect((await h.authorize('worker', 'Write', { file_path: path.join(repo.outside, 'other.txt'), content: 'x' })).behavior).toBe('deny')
    expect(h.requests).toHaveLength(2)
  })

  it('refuses NEXUS data and power with no question, and records the attempt', async () => {
    const h = enrolled('AUTONOMOUS_PROJECT', true)
    expect((await h.authorize('worker', 'Read', { file_path: path.join(process.env['APPDATA'] ?? 'C:\\Users\\x\\AppData\\Roaming', 'nexus', 'runtime', 'endpoint.json') })).behavior).toBe('deny')
    expect((await h.authorize('worker', 'Bash', { command: 'shutdown /s /t 0' })).behavior).toBe('deny')
    expect((await h.authorize('worker', 'Bash', { command: 'cat ~/.claude/.credentials.json' })).behavior).toBe('deny')
    expect(h.requests).toEqual([])
    expect(h.audit.filter((e) => e.severity === 'CREDENTIAL_ACCESS_ATTEMPT').length).toBe(2)
    expect(h.audit.some((e) => e.capability === 'HOST_POWER' && e.outcome === 'DENIED')).toBe(true)
  })

  it('holds a read-only role to its contract: it may run tests and may not ask to push', async () => {
    const h = enrolled('AUTONOMOUS_PROJECT', true)
    expect((await h.authorize('verifier', 'Bash', { command: 'pnpm test' })).behavior).toBe('allow')
    expect((await h.authorize('planner', 'Bash', { command: 'git log --oneline -5' })).behavior).toBe('allow')
    expect((await h.authorize('verifier', 'Bash', { command: 'git push origin HEAD' })).behavior).toBe('deny')
    expect(h.requests).toEqual([])
  })

  it('under BALANCED asks once for dependency installation and then never again', async () => {
    const h = enrolled('BALANCED', true)
    expect((await h.authorize('worker', 'Bash', { command: 'pnpm test' })).behavior).toBe('allow')
    expect((await h.authorize('worker', 'Bash', { command: 'pnpm install' })).behavior).toBe('deny')
    expect((await h.authorize('worker', 'Bash', { command: 'npm ci' })).behavior).toBe('deny')
    expect(h.requests).toHaveLength(1)
    h.broker.resolve({ requestId: h.requests[0]?.id ?? '', decision: 'ALLOW_PROJECT' })
    for (const command of ['pnpm install', 'npm ci', 'pnpm install --frozen-lockfile']) expect((await h.authorize('worker', 'Bash', { command })).behavior).toBe('allow')
    expect(h.requests).toHaveLength(1)
  })
})
