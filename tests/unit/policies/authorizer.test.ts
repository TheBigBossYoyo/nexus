import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENT_ROLES } from '@shared/domain'
import type { AgentRole } from '@shared/domain'
import type { ToolDecision } from '@main/modules/agent-runtime/types'
import { createAuthorizer } from '@main/modules/policies'
import type { PolicyContext } from '@main/modules/policies'

let tmp: string
let project: string
let wt: string
let outsideDir: string

beforeAll(() => {
  tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nexus-auth-')))
  project = path.join(tmp, 'project')
  wt = path.join(project, '.nexus', 'wt1')
  outsideDir = path.join(tmp, 'outside')
  for (const d of [path.join(wt, 'src'), path.join(wt, '.git'), path.join(project, 'docs'), outsideDir, path.join(tmp, 'extra')]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(path.join(wt, 'src', 'a.ts'), 'x')
  writeFileSync(path.join(wt, '.env'), 'SECRET=1')
  writeFileSync(path.join(project, 'docs', 'readme.md'), 'x')
  writeFileSync(path.join(outsideDir, 'o.txt'), 'x')
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** 8.3 alias of an existing directory, or '' when unavailable on this machine. */
function shortPath(p: string): string {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:NX_PATH).ShortPath'],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, NX_PATH: p } },
    ).trim()
  } catch {
    return ''
  }
}

function ctx(role: AgentRole, over: Partial<PolicyContext> = {}): PolicyContext {
  return { role, worktreeRoot: wt, projectRoot: project, safeCommandPrefixes: [], allowNetworkTools: false, ...over }
}
async function run(role: AgentRole, toolName: string, input: Record<string, unknown>, over: Partial<PolicyContext> = {}): Promise<ToolDecision> {
  return createAuthorizer(ctx(role, over))({ agentId: 'a', toolName, input, toolUseId: 't' })
}
const behavior = async (...args: Parameters<typeof run>) => (await run(...args)).behavior

describe('tool availability', () => {
  it('denies unknown tools, sub-agents and tools outside the role set', async () => {
    expect(await behavior('worker', 'SomethingNew', {})).toBe('deny')
    expect(await behavior('worker', 'Agent', { prompt: 'x' })).toBe('deny')
    expect(await behavior('worker', 'Task', {})).toBe('deny')
    expect(await behavior('planner', 'Write', { file_path: path.join(wt, 'x.txt') })).toBe('deny')
    expect(await behavior('reviewer', 'Edit', { file_path: path.join(wt, 'src', 'a.ts') })).toBe('deny')
    expect(await behavior('worker', 'WebFetch', { url: 'https://example.com' })).toBe('deny')
    expect(await behavior('planner', 'WebFetch', { url: 'https://example.com' })).toBe('deny')
  })

  it('allows the nexus MCP server and only explicitly listed other MCP tools', async () => {
    for (const role of AGENT_ROLES) expect(await behavior(role, 'mcp__nexus__send_message', {})).toBe('allow')
    expect(await behavior('worker', 'mcp__github__create_issue', {})).toBe('deny')
    expect(await behavior('worker', 'mcp__github__create_issue', {}, { allowedMcpTools: ['mcp__github__create_issue'] })).toBe('allow')
    expect(await behavior('worker', 'mcp__github__other', {}, { allowedMcpTools: ['mcp__github__create_issue'] })).toBe('deny')
    expect(await behavior('worker', 'mcp__github__other', {}, { allowedMcpServers: ['github'] })).toBe('allow')
    expect(await behavior('worker', 'mcp__githubevil__x', {}, { allowedMcpServers: ['github'] })).toBe('deny')
  })

  it('allows web tools only for read-only roles with network enabled', async () => {
    expect(await behavior('researcher', 'WebFetch', { url: 'https://example.com/a' }, { allowNetworkTools: true })).toBe('allow')
    expect(await behavior('researcher', 'WebSearch', { query: 'vitest' }, { allowNetworkTools: true })).toBe('allow')
    expect(await behavior('researcher', 'WebFetch', { url: 'file:///C:/x' }, { allowNetworkTools: true })).toBe('deny')
    expect(await behavior('researcher', 'WebFetch', { url: 'http://localhost:3000' }, { allowNetworkTools: true })).toBe('ask')
    expect(await behavior('researcher', 'WebFetch', { url: 'http://192.168.1.1/' }, { allowNetworkTools: true })).toBe('ask')
    expect(await behavior('worker', 'WebFetch', { url: 'https://example.com' }, { allowNetworkTools: true })).toBe('deny')
  })
})

describe('file reads', () => {
  it('allows reads in worktree, project root and extra roots, resolving relative paths against the worktree', async () => {
    expect(await behavior('planner', 'Read', { file_path: path.join(wt, 'src', 'a.ts') })).toBe('allow')
    expect(await behavior('planner', 'Read', { file_path: 'src/a.ts' })).toBe('allow')
    expect(await behavior('planner', 'Read', { file_path: 'src/new-file.ts' })).toBe('allow')
    expect(await behavior('planner', 'Read', { file_path: path.join(project, 'docs', 'readme.md') })).toBe('allow')
    expect(await behavior('planner', 'Read', { file_path: path.join(tmp, 'extra', 'x.md') }, { extraReadRoots: [path.join(tmp, 'extra')] })).toBe('allow')
    expect(await behavior('planner', 'Glob', { pattern: '**/*.ts' })).toBe('allow')
    expect(await behavior('planner', 'Grep', { pattern: 'x', path: 'src' })).toBe('allow')
  })

  it('denies reads elsewhere', async () => {
    expect(await behavior('planner', 'Read', { file_path: path.join(outsideDir, 'o.txt') })).toBe('deny')
    expect(await behavior('planner', 'Read', { file_path: 'C:\\Windows\\win.ini' })).toBe('deny')
    expect(await behavior('planner', 'Grep', { pattern: 'x', path: outsideDir })).toBe('deny')
    expect(await behavior('planner', 'Glob', { pattern: '*', path: outsideDir })).toBe('deny')
  })

  it('denies traversal, UNC, alternate separators, NUL and ADS tricks', async () => {
    const trav = '..\\..\\..\\outside\\o.txt'
    expect(await behavior('worker', 'Read', { file_path: trav })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: '../../../outside/o.txt' })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: path.join(wt, 'src', '..', '..', '..', '..', 'outside', 'o.txt') })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: `${wt.replace(/\\/g, '/')}/../../../outside/o.txt` })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: '\\\\server\\share\\x.txt' })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: '//server/share/x.txt' })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: '\\\\?\\UNC\\server\\share\\x' })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: '\\\\.\\C:\\Windows\\win.ini' })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: `${wt}\0\\..\\x` })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: `${wt}\\src\\a.ts:hidden` })).toBe('deny')
    expect(await behavior('worker', 'Read', { file_path: 42 })).toBe('deny')
    expect(await behavior('worker', 'Read', {})).toBe('deny')
  })

  it('accepts a long-path prefix only when it stays inside the boundary', async () => {
    expect(await behavior('worker', 'Read', { file_path: `\\\\?\\${path.join(wt, 'src', 'a.ts')}` })).toBe('allow')
    expect(await behavior('worker', 'Read', { file_path: `\\\\?\\${path.join(outsideDir, 'o.txt')}` })).toBe('deny')
  })

  it.skipIf(process.platform !== 'win32')('ignores drive-letter case', async () => {
    const flipped = wt.charAt(0).toLowerCase() + wt.slice(1)
    const upper = wt.charAt(0).toUpperCase() + wt.slice(1)
    for (const root of [flipped, upper]) {
      const file = path.join(root, 'src', 'a.ts')
      expect(await behavior('worker', 'Read', { file_path: file })).toBe('allow')
      expect(await behavior('worker', 'Write', { file_path: file })).toBe('allow')
      expect(await behavior('worker', 'Write', { file_path: path.join(outsideDir, 'o.txt').replace(/^./, (c) => (root === flipped ? c.toLowerCase() : c.toUpperCase())) })).toBe('deny')
    }
    expect(await behavior('worker', 'Read', { file_path: path.join(flipped, 'src', 'a.ts') }, { worktreeRoot: upper })).toBe('allow')
  })

  it.skipIf(process.platform !== 'win32')('resolves 8.3 short names of existing directories', async () => {
    const short = shortPath(wt)
    if (short === '' || short.toLowerCase() === wt.toLowerCase()) return // 8.3 generation disabled on this volume
    expect(await behavior('worker', 'Write', { file_path: path.join(short, 'src', 'b.ts') })).toBe('allow')
    expect(await behavior('worker', 'Write', { file_path: path.join(short, '..', '..', '..', 'outside', 'o.txt') })).toBe('deny')
    const gitShort = shortPath(path.join(wt, '.git'))
    expect(await behavior('worker', 'Write', { file_path: path.join(gitShort, 'config') })).toBe('deny')
  })

  it('treats the secret file list as ask/high', async () => {
    const files = [
      path.join(wt, '.env'),
      path.join(wt, '.env.local'),
      path.join(wt, 'certs', 'server.pem'),
      path.join(wt, 'tls', 'private.key'),
      path.join(wt, 'keys', 'id_rsa'),
      path.join(wt, 'keys', 'id_rsa.pub'),
      path.join(wt, 'credentials.json'),
      path.join(wt, '.npmrc'),
      path.join(wt, '.claude', '.credentials.json'),
      path.join(wt, '.ssh', 'config'),
      path.join(wt, '.aws', 'credentials'),
      '.env',
      'sub\\.env.production',
    ]
    for (const f of files) {
      const d = await run('planner', 'Read', { file_path: f })
      expect(d.behavior, f).toBe('ask')
      if (d.behavior === 'ask') {
        expect(d.risk).toBe('high')
        expect(d.reason).toContain('secret')
      }
    }
    expect(await behavior('planner', 'Read', { file_path: path.join(wt, '.env.example') })).toBe('allow')
    expect(await behavior('planner', 'Grep', { pattern: 'KEY', path: path.join(wt, '.env') })).toBe('ask')
  })

  it('gates secrets only after the boundary: out-of-bounds secrets are denied', async () => {
    expect(await behavior('planner', 'Read', { file_path: 'C:\\Users\\someone\\.ssh\\id_rsa' })).toBe('deny')
  })

  it('stops glob patterns from climbing out of the search root', async () => {
    expect(await behavior('planner', 'Glob', { pattern: '../../../outside/*' })).toBe('deny')
    expect(await behavior('planner', 'Glob', { pattern: `${outsideDir}\\**\\*.txt` })).toBe('deny')
    expect(await behavior('planner', 'Glob', { pattern: 'C:\\Windows\\*.ini' })).toBe('deny')
    expect(await behavior('planner', 'Glob', { pattern: '~/*' })).toBe('deny')
    expect(await behavior('planner', 'Grep', { pattern: 'x', glob: '../../../outside/*.txt' })).toBe('deny')
    expect(await behavior('planner', 'Glob', { pattern: '../docs/*.md' })).toBe('allow')
    expect(await behavior('planner', 'Glob', { pattern: `${wt}\\src\\*.ts` })).toBe('allow')
  })
})

describe('file writes', () => {
  it('allows writes inside the worktree for writing roles, including not-yet-existing files', async () => {
    for (const role of ['worker', 'debugger'] as const) {
      expect(await behavior(role, 'Write', { file_path: path.join(wt, 'src', 'a.ts') })).toBe('allow')
      expect(await behavior(role, 'Edit', { file_path: 'src/a.ts' })).toBe('allow')
      expect(await behavior(role, 'Write', { file_path: 'brand\\new\\dir\\file.ts' })).toBe('allow')
      expect(await behavior(role, 'NotebookEdit', { notebook_path: 'nb.ipynb' })).toBe('allow')
      expect(await behavior(role, 'TodoWrite', { todos: [] })).toBe('allow')
    }
  })

  it('denies writes outside the worktree: project root with an explanation, elsewhere by default', async () => {
    const inProject = await run('worker', 'Write', { file_path: path.join(project, 'docs', 'readme.md') })
    expect(inProject.behavior).toBe('deny')
    if (inProject.behavior === 'deny') expect(inProject.reason).toMatch(/project root/i)
    const elsewhere = await run('worker', 'Write', { file_path: path.join(outsideDir, 'o.txt') })
    expect(elsewhere.behavior).toBe('deny')
    if (elsewhere.behavior === 'deny') expect(elsewhere.reason).toMatch(/denied by default/i)
    expect(await behavior('worker', 'Edit', { file_path: '..\\..\\..\\outside\\o.txt' })).toBe('deny')
    expect(await behavior('worker', 'Write', { file_path: '\\\\server\\share\\x' })).toBe('deny')
    expect(await behavior('worker', 'Write', { file_path: 'C:\\Windows\\System32\\x.dll' })).toBe('deny')
    expect(await behavior('worker', 'NotebookEdit', { notebook_path: path.join(outsideDir, 'x.ipynb') })).toBe('deny')
  })

  it('never writes inside .git, whatever the spelling', async () => {
    for (const f of [
      path.join(wt, '.git', 'config'),
      path.join(wt, '.git', 'hooks', 'pre-commit'),
      '.git/config',
      '.git\\HEAD',
      '.GIT\\config',
      '.git.\\config',
      '.git \\config',
      'src\\..\\.git\\config',
      path.join(wt, 'sub', '.git', 'config'),
    ]) {
      expect(await behavior('worker', 'Write', { file_path: f }), f).toBe('deny')
      expect(await behavior('worker', 'Edit', { file_path: f }), f).toBe('deny')
    }
    expect(await behavior('worker', 'Write', { file_path: '.gitignore' })).toBe('allow')
    expect(await behavior('worker', 'Write', { file_path: '.github/workflows/ci.yml' })).toBe('allow')
  })

  it('stops symlinks and junctions from escaping the worktree when they can be created', async () => {
    const link = path.join(wt, 'escape-link')
    try {
      symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // cannot create links in this environment
    }
    expect(await behavior('worker', 'Write', { file_path: path.join(link, 'o.txt') })).toBe('deny')
    expect(await behavior('worker', 'Write', { file_path: 'escape-link/new.txt' })).toBe('deny')
    expect(await behavior('planner', 'Read', { file_path: 'escape-link/o.txt' })).toBe('deny')
    expect(await behavior('worker', 'Write', { file_path: 'escape-link\\..\\src\\x.ts' })).toBe('allow')
  })

  it('stops a dangling symlink from being written through', async () => {
    const link = path.join(wt, 'dangling')
    try {
      symlinkSync(path.join(outsideDir, 'does-not-exist.txt'), link, 'file')
    } catch {
      return
    }
    expect(await behavior('worker', 'Write', { file_path: link })).toBe('deny')
  })
})

describe('shell policy by role', () => {
  const shells = ['Bash', 'PowerShell'] as const

  it('inspection-only roles run only provably read-only commands', async () => {
    for (const role of ['planner', 'architect', 'researcher', 'security_reviewer'] as const) {
      for (const tool of shells) {
        expect(await behavior(role, tool, { command: 'git status' })).toBe('allow')
        expect(await behavior(role, tool, { command: 'git log --oneline -n 5 | head -n 3' })).toBe('allow')
        expect(await behavior(role, tool, { command: 'git diff' })).toBe('allow')
        expect(await behavior(role, tool, { command: 'echo hi' })).toBe('allow')
        expect(await behavior(role, tool, { command: 'node --version' })).toBe('allow')
        for (const bad of [
          'echo hi > x.txt',
          'git status > status.txt',
          'git status >> status.txt',
          'Get-Content a.txt | Out-File b.txt',
          'Set-Content a.txt hi',
          'cat a | tee b',
          'pnpm test',
          'pnpm install',
          'npm run build',
          'mkdir x',
          'git commit -m x',
          'git add .',
          'rm file.txt',
          'rm -rf node_modules',
          'git push',
          'node script.js',
          'curl https://example.com',
          'git branch newbranch',
        ]) {
          expect(await behavior(role, tool, { command: bad }), `${role}/${tool}: ${bad}`).toBe('deny')
        }
      }
    }
  })

  it('gives actionable deny reasons', async () => {
    const d = await run('planner', 'Bash', { command: 'pnpm test' })
    expect(d.behavior).toBe('deny')
    if (d.behavior === 'deny') {
      expect(d.reason).toContain('planner')
      expect(d.reason).toContain('pnpm')
      expect(d.reason).toMatch(/read-only/i)
    }
  })

  it('reviewers and verifiers run inspection plus test/build commands, nothing that writes', async () => {
    for (const role of ['reviewer', 'verifier'] as const) {
      for (const tool of shells) {
        for (const ok of [
          'git diff main...HEAD',
          'pnpm test',
          'pnpm run lint',
          'pnpm run typecheck',
          'pnpm build',
          'pnpm exec vitest run tests/unit',
          'npx tsc --noEmit',
          'pytest -q',
          'cargo test',
          'go test ./...',
          'dotnet test',
          'make test',
          'pnpm lint && pnpm test',
          'pnpm test 2>&1',
        ]) {
          expect(await behavior(role, tool, { command: ok }), `${role}/${tool}: ${ok}`).toBe('allow')
        }
        for (const bad of [
          'pnpm test > results.txt',
          'pnpm exec eslint --fix src',
          'npm install -g typescript',
          'pnpm add left-pad',
          'git commit -am x',
          'git add .',
          'echo x > f',
          'Set-Content a b',
          'rm -rf dist',
          'node build.js',
          'pnpm publish',
          'pnpm test && git push',
          'pnpm test; rm x.txt',
          'npx some-random-package',
        ]) {
          expect(await behavior(role, tool, { command: bad }), `${role}/${tool}: ${bad}`).toBe('deny')
        }
      }
    }
  })

  it('asks (low) for plain installs from reviewers and verifiers', async () => {
    for (const cmd of ['pnpm install', 'npm ci', 'pnpm install --frozen-lockfile']) {
      const d = await run('verifier', 'Bash', { command: cmd })
      expect(d, cmd).toMatchObject({ behavior: 'ask', risk: 'low' })
    }
  })

  it('honours safeCommandPrefixes for reviewers only on whole words', async () => {
    const over = { safeCommandPrefixes: ['pnpm run e2e'] }
    expect(await behavior('verifier', 'Bash', { command: 'pnpm run e2e --headed' }, over)).toBe('allow')
    expect(await behavior('verifier', 'Bash', { command: 'pnpm run e2e-clean' }, over)).toBe('deny')
    expect(await behavior('verifier', 'Bash', { command: 'pnpm run e2e && git push' }, over)).toBe('deny')
    expect(await behavior('planner', 'Bash', { command: 'pnpm run e2e' }, over)).toBe('deny')
  })

  it('writing roles run normal work in the worktree without prompts', async () => {
    for (const role of ['worker', 'debugger'] as const) {
      for (const tool of shells) {
        for (const ok of [
          'git add -A',
          'git commit -m "feat: x"',
          'git status',
          'git diff',
          'pnpm install',
          'pnpm add left-pad',
          'npm install',
          'pnpm test',
          'node script.js',
          'mkdir build',
          'echo hi > out.txt',
          'rm old.txt',
          'git stash',
          'pnpm exec eslint --fix src',
        ]) {
          expect(await behavior(role, tool, { command: ok }), `${role}/${tool}: ${ok}`).toBe('allow')
        }
      }
    }
  })

  it('asks (with a risk level) for gated actions, and the reason names the problem', async () => {
    const cases: Array<[string, 'low' | 'medium' | 'high']> = [
      ['git push origin main', 'medium'],
      ['git push --force', 'high'],
      ['git reset --hard', 'high'],
      ['rm -rf node_modules', 'high'],
      ['npm publish', 'high'],
      ['npm install -g x', 'high'],
      ['pip install x', 'medium'],
      ['curl https://example.com', 'medium'],
      ['cat .env', 'high'],
      ['cd C:\\Windows', 'medium'],
      ['npm update', 'medium'],
    ]
    for (const [cmd, risk] of cases) {
      for (const tool of shells) {
        const d = await run('worker', tool, { command: cmd })
        expect(d, `${tool}: ${cmd}`).toMatchObject({ behavior: 'ask', risk })
        if (d.behavior === 'ask') expect(d.reason.length).toBeGreaterThan(5)
      }
    }
  })

  it('asks high when the tool asks to leave its sandbox', async () => {
    expect(await run('worker', 'Bash', { command: 'git status', dangerouslyDisableSandbox: true })).toMatchObject({ behavior: 'ask', risk: 'high' })
  })

  it('denies forbidden commands for every role, with no approval path', async () => {
    for (const role of AGENT_ROLES) {
      for (const tool of shells) {
        for (const cmd of ['cat ~/.claude/.credentials.json', 'Set-MpPreference -DisableRealtimeMonitoring $true']) {
          const d = await run(role, tool, { command: cmd })
          expect(d.behavior, `${role}/${tool}: ${cmd}`).toBe('deny')
          if (d.behavior === 'deny') expect(d.reason).toMatch(/forbidden/i)
        }
      }
    }
  })

  it('asks for secret reads via shell even for read-only roles, and denies destructive commands outright for them', async () => {
    expect(await behavior('planner', 'Bash', { command: 'cat .env' })).toBe('ask')
    expect(await behavior('planner', 'PowerShell', { command: 'Get-Content .env' })).toBe('ask')
    expect(await behavior('planner', 'Bash', { command: 'cat ../../../outside/o.txt' })).toBe('ask')
    expect(await behavior('planner', 'Bash', { command: 'rm -rf .' })).toBe('deny')
  })

  it('denies missing or non-string commands', async () => {
    for (const input of [{}, { command: '' }, { command: 42 }, { command: null }]) {
      expect(await behavior('worker', 'Bash', input)).toBe('deny')
    }
  })
})

describe('never throws', () => {
  it('turns any internal failure or hostile input into a deny', async () => {
    const weird = [undefined, null, 5, 'str', [], {}, { command: {} }, { file_path: {} }, { file_path: '\0' }, { command: 'a'.repeat(200_000) }]
    for (const role of AGENT_ROLES) {
      const authorize = createAuthorizer(ctx(role, { allowNetworkTools: true }))
      for (const toolName of ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'TodoWrite', 'mcp__x__y', '', 'Agent']) {
        for (const input of weird) {
          const d = await authorize({ agentId: 'a', toolName, input: input as Record<string, unknown>, toolUseId: 't' })
          expect(['allow', 'deny', 'ask']).toContain(d.behavior)
        }
      }
    }
  })

  it('denies when the context itself is unusable', async () => {
    const authorize = createAuthorizer({ ...ctx('worker'), worktreeRoot: '\0bad', projectRoot: '\0bad' })
    const d = await authorize({ agentId: 'a', toolName: 'Write', input: { file_path: 'x.txt' }, toolUseId: 't' })
    expect(d.behavior).toBe('deny')
  })
})

describe('WebFetch private-address detection', () => {
  const fetchBehavior = (url: string) => behavior('researcher', 'WebFetch', { url }, { allowNetworkTools: true })

  it.each([
    'http://localhost./',
    'http://LOCALHOST.:8080/',
    'http://foo.localhost/',
    'http://intranet/',
    'http://[::1]/',
    'http://[::]/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[fd00::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0x7f000001/',
    'http://017700000001/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://127.0.0.1./',
    'http://0.0.0.0/',
    'http://0.1.2.3/',
    'http://0/',
    'http://100.64.0.1/',
    'http://100.127.255.255/',
    'http://169.254.169.254/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.0.1/',
    'http://10.1.2.3/',
  ])('asks for %s', async (url) => {
    expect(await fetchBehavior(url)).toBe('ask')
  })

  it.each([
    'https://example.com/',
    'https://example.com./',
    'http://8.8.8.8/',
    'http://100.128.0.1/',
    'http://172.32.0.1/',
    'http://[2606:4700:4700::1111]/',
    'http://[::ffff:808:808]/',
  ])('allows %s', async (url) => {
    expect(await fetchBehavior(url)).toBe('allow')
  })
})
