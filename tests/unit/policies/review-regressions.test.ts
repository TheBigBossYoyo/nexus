import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentRole } from '@shared/domain'
import { actionSummary, createAuthorizer, ProvenanceTracker } from '@main/modules/policies'
import { interpreterFor, parseInterpreter } from '@main/modules/policies/interpreters'
import { parsePackageManager } from '@main/modules/policies/package-scripts'

// Unit regressions for the findings of the independent review of the 0.7 execution policy (the command-level
// cases are in the adversarial corpus).

describe('decision-log redaction', () => {
  it('redacts credentials in every common spelling', () => {
    const cases: [string, string[]][] = [
      ['curl -u alice:hunter2 https://example.invalid/x', ['hunter2']],
      ['curl --user alice:hunter2 https://example.invalid/x', ['hunter2']],
      ['sshpass -p hunter2 ssh host', ['hunter2']],
      ['mysql -uroot -phunter2 db', ['hunter2']],
      ['mysql -phunter2', ['hunter2']],
      ['tool --password hunter2 run', ['hunter2']],
      ['tool --token hunter2 run', ['hunter2']],
      ['tool --api-key=hunter2 run', ['hunter2']],
      ['curl -H "Authorization: Bearer hunter2hunter2" https://example.invalid', ['hunter2hunter2']],
      ["curl -H 'X-Api-Key: hunter2' https://example.invalid", ['hunter2']],
      ['curl -H "Cookie: session=hunter2" https://example.invalid', ['hunter2']],
      ['curl "https://example.invalid/x?sig=hunter2&a=1"', ['hunter2']],
      ['curl "https://example.invalid/x?a=1&token=hunter2"', ['hunter2']],
      ['curl "https://example.invalid/x?key=hunter2"', ['hunter2']],
      ['git clone https://user:hunter2@example.invalid/r.git', ['hunter2']],
    ]
    for (const [cmd, secrets] of cases) {
      const out = actionSummary('Bash', { command: cmd })
      for (const s of secrets) expect(out, cmd).not.toContain(s)
    }
    expect(actionSummary('Bash', { command: 'pnpm test --filter a' })).toBe('pnpm test --filter a')
  })

  it('redacts before it truncates, so a token cut by the length limit leaves no fragment', () => {
    for (const pad of [150, 180, 190, 195, 199, 280, 290]) {
      const out = actionSummary('Bash', { command: `echo ${'a'.repeat(pad)} --token SECRETVALUE1234567890` })
      expect(out, `pad ${pad}`).not.toContain('SECRET')
      expect(out.length).toBeLessThanOrEqual(300)
    }
  })
})

describe('base-commit cache', () => {
  it('is keyed by reader (worktree and base commit), not by path alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nexus-cache-'))
    try {
      const file = path.join(dir, 'a.js')
      writeFileSync(file, 'same')
      const t = new ProvenanceTracker()
      const reader = (content: string | null, key?: string) => ({ ...(key === undefined ? {} : { key }), show: async () => content })
      expect(await t.statusVsBase(file, dir, reader('same', 'proj-a|c1'))).toBe('unchanged')
      // Another project and base commit with the same relative path must not read the first one's cached content.
      expect(await t.statusVsBase(file, dir, reader('different', 'proj-b|c2'))).toBe('modified')
      expect(await t.statusVsBase(file, dir, reader(null, 'proj-c|c3'))).toBe('new')
      // Readers without a key are told apart by identity.
      expect(await t.statusVsBase(file, dir, reader('same'))).toBe('unchanged')
      expect(await t.statusVsBase(file, dir, reader('other'))).toBe('modified')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('interpreter names', () => {
  it('recognises variants of the PowerShell hosts and more interpreters', () => {
    for (const w of ['pwsh-preview', 'pwsh-preview.exe', 'C:\\Program Files\\PowerShell\\7-preview\\pwsh-preview.exe', 'pwsh-lts', 'powershell7', 'pwsh_7', 'POWERSHELL.EXE.']) {
      expect(interpreterFor(w)?.family, w).toBe('powershell')
    }
    for (const [w, f] of [['lua', 'lua'], ['Rscript', 'r'], ['tclsh', 'tcl'], ['groovy', 'groovy'], ['java', 'java'], ['go', 'go'], ['dotnet', 'dotnet'], ['wsl', 'wsl'], ['julia', 'julia']] as const) {
      expect(interpreterFor(w)?.family, w).toBe(f)
    }
    for (const w of ['git', 'pnpm', 'powers', 'vitest']) expect(interpreterFor(w), w).toBeNull()
  })

  it('treats stdin-fed forms as stdin and names the source files of compiled launchers', () => {
    const t = (cmd: string, args: string[]) => parseInterpreter(interpreterFor(cmd)!, args)
    expect(t('python', ['-'])).toEqual({ kind: 'stdin' })
    expect(t('node', ['-'])).toEqual({ kind: 'stdin' })
    expect(t('bash', ['-s'])).toEqual({ kind: 'stdin' })
    expect(t('powershell', ['-Command', '-'])).toEqual({ kind: 'stdin' })
    expect(t('java', ['Foo.java'])).toMatchObject({ kind: 'script', path: 'Foo.java' })
    expect(t('go', ['run', 'a.go', 'b.go'])).toMatchObject({ kind: 'script', path: 'a.go', extraPaths: ['b.go'] })
    expect(t('dotnet', ['script', 'x.csx'])).toMatchObject({ kind: 'script', path: 'x.csx' })
  })
})

describe('package manager parsing', () => {
  it('finds the sub-command behind a flag it does not know and fails closed when it cannot', () => {
    expect(parsePackageManager('npm', ['--otp', '1', 'run', 'build']).invocation).toEqual({ kind: 'script', name: 'build', hooks: true })
    expect(parsePackageManager('pnpm', ['--use-node-version', '20', 'run', 'build']).invocation).toEqual({ kind: 'script', name: 'build', hooks: true })
    expect(parsePackageManager('pnpm', ['--use-node-version', '20', 'build']).ambiguous).toBe(true)
    expect(parsePackageManager('pnpm', ['lint', '--fix']).ambiguous).toBe(false)
    expect(parsePackageManager('npm', ['run', 'x', '--script-shell=./e.cmd']).scriptShell).toBe('./e.cmd')
    expect(parsePackageManager('npm', ['--script-shell', './e.cmd', 'test']).scriptShell).toBe('./e.cmd')
    expect(parsePackageManager('pnpm', ['-w', 'test']).invocation).toEqual({ kind: 'script', name: 'test', hooks: true })
  })
})

describe('NEXUS runtime endpoint through the file tools', () => {
  const root = path.join(tmpdir(), 'nexus-review-wt')
  const data = 'C:\\Users\\x\\AppData\\Roaming\\NEXUS'
  const decide = (role: AgentRole, toolName: string, input: Record<string, unknown>) =>
    createAuthorizer({ role, worktreeRoot: root, projectRoot: root, safeCommandPrefixes: [], allowNetworkTools: false })({ agentId: 'a', toolName, input, toolUseId: 't' })

  it('refuses reading, writing, searching and globbing the endpoint, its log, its directory and the pipe', async () => {
    const paths = [`${data}\\runtime\\endpoint.json`, `${data}\\runtime\\runtime.log`, `${data}\\runtime\\`, `${data}\\nexus.db`, '\\\\.\\pipe\\nexus-runtime-abc', 'runtime\\endpoint.json']
    for (const p of paths) {
      for (const tool of ['Read', 'Write', 'Edit'] as const) expect((await decide('worker', tool, { file_path: p })).behavior, `${tool} ${p}`).toBe('deny')
      expect((await decide('planner', 'Read', { file_path: p })).behavior, p).toBe('deny')
      expect((await decide('planner', 'Grep', { pattern: 'x', path: p })).behavior, p).toBe('deny')
    }
    expect((await decide('planner', 'Glob', { pattern: `${data}\\runtime\\*` })).behavior).toBe('deny')
  })

  it('does not treat a worktree under the data directory as NEXUS data', async () => {
    const d = await decide('worker', 'Read', { file_path: `${data}\\worktrees\\abc\\a.ts` })
    expect(d.behavior === 'deny' ? d.reason : '').not.toMatch(/runtime endpoint/)
  })
})
