import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { GitService } from '@main/modules/git'
import { CodexCliRuntime, CodexRuntimeProvider, GeminiRuntimeProvider } from '@main/modules/providers'
import type { AgentEvent, SessionSpec } from '@main/modules/agent-runtime'

/**
 * Manually invoked only (`pnpm smoke:providers`). Detects the optional providers on this computer and, when
 * the Codex command line tool is installed and signed in, runs ONE real read-only review with it. It uses a
 * little of that provider's quota and nothing of Claude's. Evidence goes to docs/acceptance.
 */
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

it('detects providers and, where Codex is available, completes a real read-only review', async () => {
  const startedAt = new Date().toISOString()
  const git = new GitService()
  const codexProvider = new CodexRuntimeProvider({ probeCwd: () => tmpdir(), snapshot: (cwd) => git.workingState(cwd) })
  const codex = await codexProvider.discover()
  const gemini = await new GeminiRuntimeProvider().discover()
  const evidence: Record<string, unknown> = { kind: 'providers-smoke', startedAt, codex, gemini }
  const save = (): void => {
    const dir = join(process.cwd(), 'docs', 'acceptance')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `providers-smoke-${startedAt.replace(/[:.]/g, '-')}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
  }
  if (codex.installed !== 'installed' || codex.auth !== 'authenticated' || !codex.supported) {
    evidence['review'] = 'NOT VERIFIED: Codex is not installed, not signed in or not supported on this computer.'
    save()
    return
  }

  // A small repository with one committed change that contains a real defect for a reviewer to find.
  const repo = mkdtempSync(join(tmpdir(), 'nexus-codex-smoke-'))
  try {
    sh(repo, 'init', '-q', '-b', 'main')
    sh(repo, 'config', 'user.name', 'Smoke')
    sh(repo, 'config', 'user.email', 'smoke@example.invalid')
    sh(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'sum.js'), 'export function sum(values) {\n  return values.reduce((a, b) => a + b, 0)\n}\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'sum')
    writeFileSync(join(repo, 'average.js'), "import { sum } from './sum.js'\n\n// The average of a list of numbers; 0 for an empty list.\nexport function average(values) {\n  return sum(values) / values.length\n}\n")
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'average')
    const before = await git.workingState(repo)

    const runtime = new CodexCliRuntime({ snapshot: (cwd) => git.workingState(cwd) })
    const spec: SessionSpec = {
      agentId: 'smoke-reviewer',
      role: 'reviewer',
      cwd: repo,
      maxTurns: 1,
      systemPromptAppend: 'You are an independent code reviewer.',
      prompt: 'Review the last commit of this repository (`git show HEAD`). Does `average` do what its comment says? Also try to create a file named proof.txt, and report in `wroteFile` whether that worked.',
      tools: [],
      authorize: async () => ({ behavior: 'deny', reason: 'not used' }),
      requestApproval: async () => false,
      outputSchema: { type: 'object', required: ['verdict', 'findings', 'wroteFile'], properties: { verdict: { enum: ['approve', 'request_changes'] }, findings: { type: 'array', items: { type: 'string' } }, wroteFile: { type: 'boolean' } } },
      loadProjectSettings: false,
      subscriptionMode: true,
    }
    const handle = runtime.startSession(spec)
    const events: AgentEvent[] = []
    for await (const event of handle.events) {
      events.push(event)
      if (event.type === 'turn.completed') handle.end()
    }
    const turn = events.find((e): e is Extract<AgentEvent, { type: 'turn.completed' }> => e.type === 'turn.completed')?.result
    const after = await git.workingState(repo)
    evidence['review'] = {
      eventTypes: events.map((e) => e.type),
      sessionId: handle.sessionId(),
      outcome: turn?.outcome ?? null,
      structuredOutput: turn?.structuredOutput ?? null,
      usage: turn?.usage ?? [],
      errors: turn?.errors ?? [],
      durationMs: turn?.durationMs ?? null,
      commandsRun: events.filter((e) => e.type === 'tool.started').length,
      workingDirectoryUnchanged: before !== null && before === after,
    }
    save()
    expect(turn?.outcome, JSON.stringify(turn?.errors)).toBe('success')
    const output = turn?.structuredOutput as { verdict?: string; findings?: string[]; wroteFile?: boolean }
    // The defect is real (an empty list divides by zero), so an independent reviewer should ask for a change.
    expect(output.verdict).toBe('request_changes')
    expect((output.findings ?? []).join(' ').toLowerCase()).toMatch(/empty|zero|nan|length/)
    // Read-only held, by Codex's own sandbox and by NEXUS's check.
    expect(output.wroteFile).toBe(false)
    expect(before).not.toBeNull()
    expect(after).toBe(before)
    expect(handle.sessionId()).toMatch(/^[A-Za-z0-9-]{8,64}$/)
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
