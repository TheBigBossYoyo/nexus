import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BASE_FILES, CORPUS, type CorpusCase, type Expect } from '../../fixtures/adversarial-corpus'
import { REVIEW_CASES } from '../../fixtures/adversarial-corpus-review'
import { REVIEW2_CASES } from '../../fixtures/adversarial-corpus-review2'
import { createFixtureRepo, git, type FixtureRepo } from '../../fixtures/malicious-repos'

// 0.7 regression corpus: what the authorizer decides for direct, indirect, inline, package-manager and
// obfuscated attempts to run something dangerous, and for the everyday commands that must keep working.
// Static inspection narrows what can happen; the corpus pins down what it does catch (docs/SECURITY.md).

let repo: FixtureRepo

beforeAll(() => {
  repo = createFixtureRepo(BASE_FILES)
  // A locally installed dev tool, as after `pnpm install` (node_modules is git-ignored, like in a real checkout).
  mkdirSync(path.join(repo.root, 'node_modules', '.bin'), { recursive: true })
  for (const tool of ['vitest', 'tsc', 'eslint']) writeFileSync(path.join(repo.root, 'node_modules', '.bin', `${tool}.cmd`), '@echo off\r\n')
})
afterAll(() => repo.cleanup())
afterEach(() => {
  git(repo.root, 'checkout', '-q', '--', '.')
  git(repo.root, 'clean', '-fdq')
  repo.decisions.length = 0
})

const matches = (got: string, want: Expect): boolean => (want === 'blocked' ? got === 'ask' || got === 'deny' : got === want)

async function decide(c: CorpusCase) {
  for (const [rel, content] of Object.entries(c.agent ?? {})) repo.write(rel, content)
  return repo.authorize(c.role ?? 'worker', c.shell ?? 'Bash', { command: c.command }, {}, c.profile ?? 'STANDARD')
}

describe('adversarial corpus', () => {
  for (const c of [...CORPUS, ...REVIEW_CASES, ...REVIEW2_CASES]) {
    it(`[${c.group}] ${c.id}`, async () => {
      const d = await decide(c)
      expect(matches(d.behavior, c.expect), `${c.command} -> ${JSON.stringify(d)}`).toBe(true)
      const reason = d.behavior === 'allow' ? '' : d.reason
      if (c.why !== undefined) expect(reason.toLowerCase(), `${c.command} -> ${reason}`).toContain(c.why.toLowerCase())
      if (c.audit === true) {
        expect(repo.decisions.some((x) => x.decision === 'ALLOW_WITH_AUDIT'), `no audit row for ${c.command}`).toBe(true)
      }
      // Every deny and every approval request is in the log; a plain allow of a read-only command is not.
      if (d.behavior === 'deny') expect(repo.decisions.some((x) => x.decision === 'DENY')).toBe(true)
      if (d.behavior === 'ask') expect(repo.decisions.some((x) => x.decision === 'REQUIRE_APPROVAL')).toBe(true)
    })
  }

  it('has a substantial corpus', () => {
    expect(CORPUS.length).toBeGreaterThan(150)
    for (const g of ['direct', 'indirect', 'inline', 'package', 'obfuscation', 'usable'] as const) {
      expect(CORPUS.filter((c) => c.group === g).length, g).toBeGreaterThan(10)
    }
  })
})

describe('decision log content', () => {
  it('classifies a power attempt as SYSTEM_SENSITIVE and an agent script as agent-authored', async () => {
    repo.write('foo.ps1', 'Stop-Computer\n')
    await repo.authorize('worker', 'Bash', { command: 'powershell foo.ps1' })
    const power = repo.decisions.find((d) => d.decision === 'DENY')
    expect(power?.classification).toBe('SYSTEM_SENSITIVE')
    expect(power?.provenance).toBe('agent_authored')
    expect(power?.policyVersion).toMatch(/exec/)
    expect(power?.runId).toBe('run-1')
    expect(power?.taskId).toBe('task-1')
    expect(power?.agentId).toBe('agent-1')
  })

  it('records the provenance of an agent-modified package script', async () => {
    const pkg = JSON.parse(BASE_FILES['package.json'] ?? '{}') as { scripts: Record<string, string> }
    pkg.scripts.test = 'vitest run --coverage'
    repo.write('package.json', JSON.stringify(pkg))
    await repo.authorize('worker', 'Bash', { command: 'pnpm test' })
    const row = repo.decisions.find((d) => d.decision === 'ALLOW_WITH_AUDIT')
    expect(row?.provenance).toBe('agent_modified')
    expect(row?.classification).toBe('UNTRUSTED_AGENT_AUTHORED')
  })

  it('never stores secrets or long opaque strings from the command', async () => {
    await repo.authorize('worker', 'Bash', { command: 'curl -H "Authorization: Bearer sk-abcdef0123456789abcdef" --token hunter2hunter2 http://example.invalid?api_key=SECRETVALUE123' })
    const row = repo.decisions[0]
    expect(row).toBeDefined()
    const all = JSON.stringify(row)
    for (const secret of ['hunter2hunter2', 'SECRETVALUE123', 'sk-abcdef0123456789abcdef']) expect(all).not.toContain(secret)
  })

  it('does not log a plain read-only allow', async () => {
    await repo.authorize('worker', 'Bash', { command: 'git status' })
    await repo.authorize('worker', 'Read', { file_path: 'package.json' })
    expect(repo.decisions).toHaveLength(0)
  })

  it('learns who wrote a file from the Write tool and from a shell redirection', async () => {
    await repo.authorize('worker', 'Write', { file_path: 'w1.js', content: "console.log('a')\n" })
    await repo.authorize('worker', 'Bash', { command: 'echo hi > w2.txt' })
    expect(repo.tracker.recorded(path.join(repo.root, 'w1.js'), repo.root)?.createdByAgentId).toBe('agent-1')
    expect(repo.tracker.recorded(path.join(repo.root, 'w1.js'), repo.root)?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(repo.tracker.recorded(path.join(repo.root, 'w2.txt'), repo.root)?.runId).toBe('run-1')
  })

  it('treats a file as agent-modified from the base-commit diff alone (no recorded write, as after a restart)', async () => {
    writeFileSync(path.join(repo.root, 'scripts', 'gen.js'), "require('child_process').execSync('shutdown /s')\n")
    const d = await repo.authorize('worker', 'Bash', { command: 'node scripts/gen.js' })
    expect(d.behavior).toBe('deny')
    expect(repo.decisions.find((x) => x.decision === 'DENY')?.provenance).toBe('agent_modified')
  })

  it('does not call a CRLF checkout of an unchanged file modified', async () => {
    writeFileSync(path.join(repo.root, 'scripts', 'gen.js'), "console.log('generated')\r\n")
    const d = await repo.authorize('worker', 'Bash', { command: 'node scripts/gen.js' })
    expect(d.behavior).toBe('allow')
    expect(repo.decisions).toHaveLength(0)
  })
})

describe('base reader', () => {
  it('reads the base version of a file and reports a missing one as absent', async () => {
    const { gitBaseReader } = await import('@main/modules/policies')
    const reader = gitBaseReader(
      async (cwd, args) => {
        try {
          return { exitCode: 0, stdout: execFileSync('git', [...args], { cwd, encoding: 'utf8' }) }
        } catch {
          return { exitCode: 128, stdout: '' }
        }
      },
      repo.root,
      repo.base,
    )
    expect(await reader.show('scripts/gen.js')).toContain('generated')
    expect(await reader.show('nope.js')).toBeNull()
    await expect(reader.show('--output=x')).rejects.toThrow()
  })
})
