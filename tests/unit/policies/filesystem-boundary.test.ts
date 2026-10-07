import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentRole } from '@shared/domain'
import { createAuthorizer } from '@main/modules/policies'
import { canonicalizePath, isPathInside } from '@main/modules/policies/paths'

// 0.7 filesystem boundary: adversarial path spellings and real junctions against the authorizer. A path is
// compared canonically (resolved through links, case-insensitively), never by string prefix.

let tmp: string
let project: string
let wt: string
let outside: string
let linkOut = ''
let linkUp = ''
let linkIn = ''

beforeAll(() => {
  tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nexus-fs-')))
  project = path.join(tmp, 'project')
  wt = path.join(project, '.nexus', 'wt1')
  outside = path.join(tmp, 'outside')
  // A sibling whose name starts with the worktree's name: a string-prefix check would call it inside.
  mkdirSync(`${project}-evil`, { recursive: true })
  mkdirSync(`${wt}-evil`, { recursive: true })
  for (const d of [path.join(wt, 'src'), path.join(wt, '.git'), path.join(wt, 'long_directory_name'), outside]) mkdirSync(d, { recursive: true })
  writeFileSync(path.join(wt, 'src', 'a.ts'), 'x')
  writeFileSync(path.join(outside, 'o.txt'), 'secret')
  const link = (name: string, target: string): string => {
    const p = path.join(wt, name)
    try {
      symlinkSync(target, p, process.platform === 'win32' ? 'junction' : 'dir')
      return p
    } catch {
      return ''
    }
  }
  linkOut = link('jout', outside)
  linkUp = link('jup', project)
  linkIn = link('jin', path.join(wt, 'src'))
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(`${wt}-evil`, { recursive: true, force: true })
})

async function decide(role: AgentRole, toolName: string, input: Record<string, unknown>) {
  return createAuthorizer({ role, worktreeRoot: wt, projectRoot: project, safeCommandPrefixes: [], allowNetworkTools: false })({ agentId: 'a', toolName, input, toolUseId: 't' })
}
const b = async (role: AgentRole, toolName: string, input: Record<string, unknown>) => (await decide(role, toolName, input)).behavior

function shortPath(p: string): string {
  try {
    const s = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:NX_PATH).ShortPath'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, NX_PATH: p } }).trim()
    return s.toLowerCase() === p.toLowerCase() ? '' : s
  } catch {
    return ''
  }
}

describe('lexical escapes', () => {
  it('denies .. traversal in every spelling for write, edit and read', async () => {
    const rel = path.relative(wt, path.join(outside, 'x.txt'))
    for (const p of [rel, rel.replace(/\\/g, '/'), `src\\..\\${rel}`, `src/../${rel.replace(/\\/g, '/')}`, path.join(outside, 'x.txt'), `${wt}\\..\\..\\..\\outside\\x.txt`, `..\\..\\..\\outside\\x.txt`, `src\\..\\..\\..\\..\\..`]) {
      expect(await b('worker', 'Write', { file_path: p }), `Write ${p}`).toBe('deny')
      expect(await b('worker', 'Edit', { file_path: p }), `Edit ${p}`).toBe('deny')
      expect(await b('worker', 'Read', { file_path: p }), `Read ${p}`).toBe('deny')
    }
  })

  it('is not fooled by a sibling directory that merely starts with the worktree name', async () => {
    expect(isPathInside(wt, `${wt}-evil`)).toBe(false)
    expect(isPathInside(project, `${project}-evil`)).toBe(false)
    expect(await b('worker', 'Write', { file_path: `${wt}-evil\\x.txt` })).toBe('deny')
    expect(await b('worker', 'Write', { file_path: `${project}-evil\\x.txt` })).toBe('deny')
    expect(await b('worker', 'Read', { file_path: `${project}-evil\\x.txt` })).toBe('deny')
  })

  it('denies UNC, device and extended-length paths outside the worktree', async () => {
    for (const p of ['\\\\server\\share\\x.txt', '//server/share/x.txt', '\\\\?\\UNC\\server\\share\\x.txt', '\\\\?\\C:\\Windows\\win.ini', '\\\\.\\C:\\Windows\\win.ini', '\\\\.\\PhysicalDrive0', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x', '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x', '\\\\localhost\\c$\\x.txt', '\\??\\C:\\Windows\\x']) {
      for (const tool of ['Write', 'Edit', 'Read'] as const) expect(await b('worker', tool, { file_path: p }), `${tool} ${p}`).toBe('deny')
    }
  })

  it('accepts an extended-length spelling only when it names a path inside the worktree', async () => {
    expect(await b('worker', 'Write', { file_path: `\\\\?\\${wt}\\src\\ok.ts` })).toBe('allow')
    expect(await b('worker', 'Write', { file_path: `\\\\?\\${path.join(outside, 'x.txt')}` })).toBe('deny')
  })

  it('denies drive-relative paths, which depend on a per-drive working directory', async () => {
    const drive = wt.slice(0, 2)
    for (const p of [`${drive}foo.txt`, `${drive}src\\a.ts`, 'D:foo.txt', 'Z:..\\x']) {
      expect(await b('worker', 'Write', { file_path: p }), p).toBe('deny')
      expect(await b('worker', 'Read', { file_path: p }), p).toBe('deny')
    }
  })

  it('resolves casing differences the way Windows does', async () => {
    expect(await b('worker', 'Write', { file_path: 'SRC\\A.TS' })).toBe('allow')
    expect(await b('worker', 'Write', { file_path: wt.toUpperCase() + '\\src\\new.ts' })).toBe('allow')
    expect(await b('worker', 'Write', { file_path: `..\\..\\..\\OUTSIDE\\x.txt` })).toBe('deny')
    expect(await b('worker', 'Write', { file_path: outside.toUpperCase() + '\\x.txt' })).toBe('deny')
  })

  it('denies alternate data streams in every spelling', async () => {
    for (const p of ['src\\a.ts::$DATA', 'src\\a.ts:evil.ps1', 'src\\a.ts:evil:$DATA', 'new.txt:stream', '.git::$INDEX_ALLOCATION\\x', 'src::$INDEX_ALLOCATION\\x', `${wt}\\src\\a.ts::$DATA`]) {
      expect(await b('worker', 'Write', { file_path: p }), p).toBe('deny')
      expect(await b('worker', 'Read', { file_path: p }), p).toBe('deny')
    }
  })

  it('denies Windows device names, which are not files', async () => {
    for (const p of ['CON', 'nul', 'src\\COM1', 'aux.txt', 'LPT1.log', 'PRN']) expect(await b('worker', 'Write', { file_path: p }), p).toBe('deny')
  })

  it('denies NUL and wildcard characters', async () => {
    for (const p of ['src\\a\u0000.ts', 'src\\*.ts', 'src\\a?.ts', 'src\\<a>.ts', 'src\\"a".ts', 'src\\a|b.ts']) expect(await b('worker', 'Write', { file_path: p }), JSON.stringify(p)).toBe('deny')
  })

  it('treats trailing dots and spaces like Windows does, so .git cannot be spelled around', async () => {
    for (const p of ['.git.\\config', '.git \\config', '.git...\\hooks\\pre-commit', '.GIT\\config', '.Git\\HEAD', 'sub\\.git.\\config', 'src\\..\\.git\\config']) {
      expect(await b('worker', 'Write', { file_path: p }), p).toBe('deny')
      expect(await b('worker', 'Edit', { file_path: p }), p).toBe('deny')
    }
  })

  it('denies writing .git itself (the worktree pointer) and any nested repository metadata', async () => {
    for (const p of ['.git', '.git\\gitdir', 'sub\\.git', 'sub\\.git\\config', 'sub\\.git\\hooks\\pre-commit', 'a\\b\\.git\\info\\attributes', '.git/config']) {
      expect(await b('worker', 'Write', { file_path: p }), p).toBe('deny')
    }
    expect(await b('worker', 'NotebookEdit', { notebook_path: '.git\\x.ipynb' })).toBe('deny')
  })

  it('denies glob and grep patterns that climb out', async () => {
    for (const pattern of ['..\\..\\..\\*', '../../../*', '..\\..\\..\\**\\*.txt', 'C:\\Windows\\*', '\\\\server\\share\\*', '~\\*']) {
      expect(await b('planner', 'Glob', { pattern }), pattern).toBe('deny')
      expect(await b('reviewer', 'Grep', { pattern: 'x', glob: pattern }), pattern).toBe('deny')
    }
    expect(await b('planner', 'Glob', { pattern: 'src/**/*.ts' })).toBe('allow')
  })
})

describe('8.3 short names', () => {
  it('resolves a short name of a directory to its real location', async () => {
    const short = shortPath(path.join(wt, 'long_directory_name'))
    if (short === '') return // short names are disabled on this volume
    expect(canonicalizePath(short, wt).toLowerCase()).toBe(path.join(wt, 'long_directory_name').toLowerCase())
    expect(await b('worker', 'Write', { file_path: `${short}\\x.txt` })).toBe('allow')
    const out = shortPath(outside)
    if (out !== '') expect(await b('worker', 'Write', { file_path: `${out}\\x.txt` })).toBe('deny')
  })

  it('resolves GIT~1 to .git', async () => {
    const short = shortPath(path.join(wt, '.git'))
    if (short === '') return
    expect(await b('worker', 'Write', { file_path: `${short}\\config` })).toBe('deny')
  })
})

describe('junctions and symlinks', () => {
  it('denies reading and writing through a junction that leaves the worktree', async () => {
    if (linkOut === '') return // links cannot be created here
    for (const tool of ['Write', 'Edit'] as const) {
      expect(await b('worker', tool, { file_path: 'jout\\o.txt' })).toBe('deny')
      expect(await b('worker', tool, { file_path: 'jout\\new\\deep\\x.txt' })).toBe('deny')
      expect(await b('worker', tool, { file_path: path.join(linkOut, 'o.txt') })).toBe('deny')
    }
    expect(await b('worker', 'Read', { file_path: 'jout\\o.txt' })).toBe('deny')
    expect(await b('planner', 'Read', { file_path: 'jout\\o.txt' })).toBe('deny')
    expect(await b('planner', 'Glob', { pattern: '*.txt', path: 'jout' })).toBe('deny')
    expect(await b('planner', 'Grep', { pattern: 'secret', path: 'jout' })).toBe('deny')
    // The same name with other casing and a trailing dot is the same junction.
    expect(await b('worker', 'Write', { file_path: 'JOUT\\o.txt' })).toBe('deny')
    expect(await b('worker', 'Write', { file_path: 'jout.\\o.txt' })).toBe('deny')
  })

  it('denies a junction to the project root (readable, but not writable from a task worktree)', async () => {
    if (linkUp === '') return
    expect(await b('worker', 'Write', { file_path: 'jup\\x.txt' })).toBe('deny')
    expect(await b('worker', 'Write', { file_path: 'jup\\.nexus\\wt1\\x.txt' })).toBe('allow') // resolves back into the worktree
  })

  it('allows a junction that stays inside the worktree', async () => {
    if (linkIn === '') return
    expect(await b('worker', 'Write', { file_path: 'jin\\x.ts' })).toBe('allow')
    expect(await b('worker', 'Write', { file_path: 'jin\\.git\\x' })).toBe('deny') // a .git segment is refused wherever it is
  })

  it('asks before a shell command reaches outside through a junction, for reads and writes', async () => {
    if (linkOut === '') return
    for (const cmd of ['cat jout/o.txt', 'type jout\\o.txt', 'Set-Content jout\\x.txt hi', 'echo hi > jout/x.txt', 'cp src/a.ts jout/', 'rm jout/o.txt', 'ls jout', 'git status jout']) {
      for (const role of ['worker', 'reviewer'] as const) {
        expect(await b(role, 'Bash', { command: cmd }), `${role}: ${cmd}`).not.toBe('allow')
      }
    }
    expect(await b('worker', 'Bash', { command: 'cat src/a.ts' })).toBe('allow')
    if (linkIn !== '') expect(await b('worker', 'Bash', { command: 'cat jin/a.ts' })).toBe('allow')
  })

  it('stops a file symlink that points outside, when links can be created', async () => {
    const file = path.join(wt, 'flink.txt')
    try {
      symlinkSync(path.join(outside, 'o.txt'), file, 'file')
    } catch {
      return
    }
    expect(await b('worker', 'Write', { file_path: file })).toBe('deny')
    expect(await b('worker', 'Read', { file_path: 'flink.txt' })).toBe('deny')
  })
})

describe('.git pointer and nested repository tricks', () => {
  const attempts = [
    'echo "gitdir: C:\\victim\\.git\\worktrees\\x" > .git',
    'Set-Content .git "gitdir: C:\\victim\\.git"',
    'Out-File -FilePath .git -InputObject "gitdir: x"',
    'rm .git',
    'del .git',
    'Remove-Item -Recurse -Force .git',
    'mv .git .git.bak',
    'move .git x',
    'New-Item .git -ItemType File',
    'cmd /c "echo gitdir: x> .git"',
    'printf "gitdir: x" > ./.git',
    'echo x > sub/.git',
    'mkdir sub/.git',
    'cp evil .git/config',
    'Copy-Item evil .git\\hooks\\pre-commit',
    'tee .git <<< "gitdir: x"',
    'git --git-dir=..\\..\\victim\\.git status',
    'git --git-dir ../victim/.git log',
    'GIT_DIR=../victim/.git git status',
    'git -C ..\\.. status',
    'git --work-tree=.. status',
    'git -c core.fsmonitor=calc status',
    'git -c core.hooksPath=evil commit -m x',
    'git config core.fsmonitor calc',
    'git config core.hooksPath ./evil',
    'git -C sub config core.sshCommand calc',
    'cd sub && git config alias.x "!calc"',
  ]
  for (const cmd of attempts) {
    it(`does not let a worker do: ${cmd}`, async () => {
      for (const tool of ['Bash', 'PowerShell'] as const) {
        const d = await decide('worker', tool, { command: cmd })
        expect(d.behavior, `${tool}: ${cmd} -> ${JSON.stringify(d)}`).not.toBe('allow')
      }
    })
  }
})
