import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentRole } from '@shared/domain'
import { classifyCommand, createAuthorizer } from '@main/modules/policies'

// 0.2.1 audit fixes: obfuscated/indirect power commands, exec-capable git config, git redirected outside the
// worktree, and NEXUS's own data. This is a lexical policy: it refuses recoverable intent, nothing more.

let tmp: string
let project: string
let wt: string

beforeAll(() => {
  tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'nexus-hard-')))
  project = path.join(tmp, 'project')
  wt = path.join(project, '.nexus', 'wt1')
  mkdirSync(path.join(wt, 'src'), { recursive: true })
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

type Sh = 'bash' | 'powershell'
const WRITING: AgentRole[] = ['worker', 'debugger']
const cls = (c: string, shell: Sh) => classifyCommand(c, shell, { roots: [wt] })
async function decide(role: AgentRole, shell: Sh, command: string) {
  const authorize = createAuthorizer({ role, worktreeRoot: wt, projectRoot: project, safeCommandPrefixes: [], allowNetworkTools: false })
  return authorize({ agentId: 'a', toolName: shell === 'bash' ? 'Bash' : 'PowerShell', input: { command }, toolUseId: 't' })
}
async function expectBehavior(cmds: [string, Sh][], behavior: 'deny' | 'ask') {
  for (const [c, shell] of cmds) {
    for (const role of WRITING) {
      const d = await decide(role, shell, c)
      expect(d.behavior, `${role} ${shell}: ${c}`).toBe(behavior)
    }
  }
}

const FORBIDDEN_POWER: [string, Sh][] = [
  // obfuscated command words
  ['cmd /c "shut^down /s"', 'bash'],
  ['cmd /c "shut^down /s"', 'powershell'],
  ['shut^down /s', 'powershell'],
  ['sh\\utdown /s', 'bash'],
  ['s"h"utdown /s', 'bash'],
  ["'shut''down' /s", 'bash'],
  ["'shut''down' /s", 'powershell'],
  ['C:\\Windows\\System32\\shut^down.exe /s', 'powershell'],
  ['cmd /c %COMSPEC% /c shutdown /s', 'bash'],
  ['cmd /c %COMSPEC% /c shutdown /s', 'powershell'],
  ['& $env:COMSPEC /c shutdown /s', 'powershell'],
  // inline interpreter code
  ['node -e "require(\'child_process\').exec(\'shutdown /s\')"', 'bash'],
  ['node -p "require(\'child_process\').execSync(\'shut\'+\'down /s\')"', 'bash'],
  ['python -c "import os; os.system(\'shutdown /s\')"', 'bash'],
  ['python3 -c "import subprocess; subprocess.run([\'shutdown\', \'/s\'])"', 'bash'],
  ['python -c "import os; os.system(\'shut\' + \'down /s\')"', 'powershell'],
  ["perl -e 'system(\"shutdown\")'", 'bash'],
  ["ruby -e 'system(\"shutdown /s\")'", 'bash'],
  ['powershell -Command "Stop-Computer"', 'bash'],
  ['powershell -Command "Stop-Computer"', 'powershell'],
  ['pwsh -c "& { Restart-Computer -Force }"', 'powershell'],
  ['bash -c "shutdown -h now"', 'bash'],
  ['python -c "import ctypes; ctypes.windll.user32.ExitWindowsEx(8, 0)"', 'powershell'],
  ['python -c "import ctypes; ctypes.windll.advapi32.InitiateSystemShutdownW(None, None, 0, 1, 0)"', 'bash'],
  ['node -e "require(\'child_process\').exec(\'rundll32.exe powrprof.dll,SetSuspendState 0,1,0\')"', 'bash'],
  // .NET / COM from PowerShell
  ['[Diagnostics.Process]::Start("shutdown","/s")', 'powershell'],
  ['[System.Diagnostics.Process]::Start("shutdown.exe", "/s")', 'powershell'],
  ['[Type]::GetType("System.Diagnostics.Process")::Start("shutdown","/s")', 'powershell'],
  ['$w=New-Object -ComObject WScript.Shell; $w.Run("shutdown /s")', 'powershell'],
  ['(New-Object -ComObject Shell.Application).ShutdownWindows()', 'powershell'],
  ['Start-Process -FilePath ("shut"+"down") -ArgumentList "/s"', 'powershell'],
  ["Start-Process -FilePath ('shut'+'down') -ArgumentList '/s'", 'powershell'],
  // package runners and multi-call binaries
  ['pnpm exec shutdown /s', 'bash'],
  ['npx shutdown /s', 'bash'],
  ['npx -y shutdown /s', 'powershell'],
  ['npm exec -- shutdown /s', 'bash'],
  ['busybox poweroff', 'bash'],
  ['tsshutdn', 'powershell'],
  ['tsshutdn 0 /powerdown', 'bash'],
  // a script written and run in the same command line
  ['echo shutdown /s > x.bat && ./x.bat', 'bash'],
  ['echo shutdown /s > x.bat && cmd /c x.bat', 'powershell'],
  ["printf 'shutdown -h now\\n' > stop.sh; bash stop.sh", 'bash'],
  ["cat > off.sh <<'EOF'\nshutdown -h now\nEOF\nbash off.sh", 'bash'],
]

describe('power commands survive trivial obfuscation only as forbidden', () => {
  it.each(FORBIDDEN_POWER)('classifier forbids: %s (%s)', (c, shell) => {
    const r = cls(c, shell)
    expect(r.level, r.reasons.join('; ')).toBe('forbidden')
    expect(r.commandClass).toBe('SYSTEM_CHANGE')
  })

  it('is denied (no approval path) for worker and debugger in the matching shell', async () => {
    await expectBehavior(FORBIDDEN_POWER, 'deny')
  })

  it('does not forbid ordinary uses of the same words', () => {
    for (const [c, shell] of [
      ['node server.js', 'bash'],
      ['node -e "console.log(1+1)"', 'bash'],
      ['python script.py --shutdown-test', 'bash'],
      ['git commit -m "docs: explain graceful shutdown and child_process usage"', 'bash'],
      ['rg "shutdown" src', 'bash'],
      ['echo done > build.sh && bash build.sh', 'bash'],
      ['pnpm exec vitest run', 'bash'],
      ['npx tsc --noEmit', 'powershell'],
      ['Start-Process notepad', 'powershell'],
    ] as [string, Sh][]) {
      expect(cls(c, shell).level, `${shell}: ${c}`).not.toBe('forbidden')
    }
  })
})

describe('command names computed at run time need approval', () => {
  const DYNAMIC: [string, Sh][] = [
    ['$(echo shutdown) /s', 'bash'],
    ['s=shutdown; $s /s', 'bash'],
    ['s=shut; ${s}down now', 'bash'],
    ['`echo shutdown` /s', 'bash'],
    ['"$cmd" /s', 'bash'],
    ['bash -c "$(echo c2h1dGRvd24= | base64 -d)"', 'bash'],
    ['& $cmd', 'powershell'],
    ['& (gcm shut*)', 'powershell'],
    ['. $script', 'powershell'],
    ['cmd /c %SOMETHING% /s', 'bash'],
  ]
  it.each(DYNAMIC)('needs approval (high): %s (%s)', (c, shell) => {
    const r = cls(c, shell)
    expect(r.level, c).toBe('needs_approval')
    expect(r.risk).toBe('high')
  })
  it('asks writing roles', async () => {
    await expectBehavior(DYNAMIC, 'ask')
  })
  it('does not gate expansions in argument position', () => {
    for (const c of [
      'git commit -m "$msg"',
      'cd "$DIR" && ls',
      'FOO=$(pwd) git status',
      'x=$(git rev-parse HEAD); echo "$x"',
      'for f in $(ls); do echo "$f"; done',
      'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"',
      'ls "$(pwd)"',
    ]) {
      expect(cls(c, 'bash').level, c).not.toBe('needs_approval')
    }
    expect(cls('Write-Output $env:PATH', 'powershell').level).toBe('safe')
    expect(cls('$x = 5; Write-Output $x', 'powershell').level).not.toBe('needs_approval')
  })
})

describe('rundll32', () => {
  it.each([
    ['rundll32 user32.dll,LockWorkStation', 'bash'],
    ['rundll32.exe shell32.dll,Control_RunDLL', 'powershell'],
  ] as [string, Sh][])('needs approval: %s', async (c, shell) => {
    expect(cls(c, shell).level).toBe('needs_approval')
    await expectBehavior([[c, shell]], 'ask')
  })
})

describe('git config cannot install exec-capable keys', () => {
  const KEYS = [
    "git config alias.x '!rm -rf /'",
    'git config core.editor evil',
    'git config core.fsmonitor evil',
    'git config core.hooksPath hooks',
    'git config core.sshCommand evil',
    'git config core.pager evil',
    'git config credential.helper evil',
    'git config include.path other.cfg',
    'git config includeIf.gitdir:x.path other.cfg',
    'git config url.evil.insteadOf https://x',
    'git config filter.a.clean evil',
    'git config diff.a.textconv evil',
    'git config diff.external evil',
    'git config merge.a.driver evil',
    'git config sequence.editor evil',
    'git config gpg.program evil',
    'git config uploadpack.packObjectsHook evil',
    'git config receive.denyCurrentBranch updateInstead',
    'git config --local core.editor evil',
    'git config --worktree core.fsmonitor evil',
    'git config --global alias.x evil',
    'git config --system core.editor evil',
    'git config --file cfg.txt core.editor evil',
    'git config -f cfg.txt alias.x evil',
    'git config --add core.hooksPath hooks',
    'git config set core.editor evil',
    'git config --edit',
  ]
  it.each(KEYS)('needs approval (high): %s', (c) => {
    for (const shell of ['bash', 'powershell'] as Sh[]) {
      const r = cls(c, shell)
      expect(r.level, `${shell}: ${c}`).toBe('needs_approval')
      expect(r.risk).toBe('high')
    }
  })
  it('asks worker and debugger', async () => {
    await expectBehavior(KEYS.map((c) => [c, 'bash'] as [string, Sh]), 'ask')
  })
  it('keeps reads and harmless keys as before', async () => {
    for (const c of [
      'git config --get user.name',
      'git config --list',
      'git config -l',
      'git config --local --get-all core.editor',
      'git config user.name x',
      'git config --local user.email a@b.c',
      'git config core.autocrlf true',
      'git config --unset alias.x',
      'git config get core.editor',
    ]) {
      expect(cls(c, 'bash').level, c).toBe('write')
      for (const role of WRITING) expect((await decide(role, 'bash', c)).behavior, `${role}: ${c}`).toBe('allow')
    }
  })
})

describe('git cannot be pointed outside the worktree through indirection', () => {
  const REDIRECTED: [string, Sh][] = [
    ['P=/c/proj; git -C $P add -A', 'bash'],
    ['git -C "$P" add -A', 'bash'],
    ['git -C $(pwd)/.. add -A', 'bash'],
    ['export GIT_DIR=../../.git; git commit -am x', 'bash'],
    ['export GIT_WORK_TREE=/x && git add -A', 'bash'],
    ['declare -x GIT_INDEX_FILE=/tmp/i; git add -A', 'bash'],
    ['GIT_WORK_TREE=/x; git add -A', 'bash'],
    ['GIT_DIR=../.git git status', 'bash'],
    ['GIT_SSH_COMMAND=evil git fetch', 'bash'],
    ['GIT_EDITOR=evil git commit', 'bash'],
    ['GIT_ASKPASS=evil git fetch', 'bash'],
    ['GIT_CONFIG_GLOBAL=/x git status', 'bash'],
    ['GIT_EXEC_PATH=/x git status', 'bash'],
    ['env GIT_DIR=x git status', 'bash'],
    ['git --work-tree=/x add -A', 'bash'],
    ['git --work-tree ../.. add -A', 'bash'],
    ['git --git-dir=$X status', 'bash'],
    ['git --git-dir=../../.git status', 'bash'],
    ['git -C .. status', 'bash'],
    ['git -C ../.. status', 'powershell'],
    ['git -C C:\\other\\repo status', 'powershell'],
    ['$env:GIT_DIR = "../../.git"; git commit -am x', 'powershell'],
    ['$env:GIT_WORK_TREE="C:\\x"; git add -A', 'powershell'],
    ['Set-Item Env:GIT_DIR ../../.git', 'powershell'],
    ["[Environment]::SetEnvironmentVariable('GIT_DIR','x','Process')", 'powershell'],
  ]
  it.each(REDIRECTED)('needs approval (high): %s (%s)', (c, shell) => {
    const r = cls(c, shell)
    expect(r.level, c).toBe('needs_approval')
    expect(r.risk).toBe('high')
  })
  it('asks worker and debugger', async () => {
    await expectBehavior(REDIRECTED, 'ask')
  })
  it('allows git inside the worktree', async () => {
    for (const c of ['git -C . status', 'git -C src status', 'git --git-dir=.git status', 'git --work-tree=. status']) {
      expect(cls(c, 'bash').level, c).not.toBe('needs_approval')
      for (const role of WRITING) expect((await decide(role, 'bash', c)).behavior, `${role}: ${c}`).toBe('allow')
    }
  })
})

describe("NEXUS's own data is off limits to every role", () => {
  const DATA: [string, Sh][] = [
    ['cat nexus.db', 'bash'],
    ['cat ../../nexus.db', 'bash'],
    ['cat NEXUS.DB', 'bash'],
    ['cat nexus.db-wal', 'bash'],
    ['cp nexus.db-shm /tmp/x', 'bash'],
    ['sqlite3 ~/.nexus/nexus.db "select * from settings"', 'bash'],
    ['cat overnight.key', 'bash'],
    ['type ..\\..\\nexus.db', 'powershell'],
    ['Get-Content $env:APPDATA\\Nexus\\nexus.db', 'powershell'],
    ['Copy-Item ..\\overnight.key x', 'powershell'],
    ['python -c "open(\'../../nexus.db\',\'rb\').read()"', 'bash'],
    ['python -c "import sqlite3; sqlite3.connect(\'../../nexus.db\')"', 'powershell'],
    ['node -e "require(\'fs\').readFileSync(\'../../nexus.db\')"', 'bash'],
    ['node -e "require(\'fs\').readFileSync(\'../../overnight.key\')"', 'bash'],
    ["python -c \"open('nexus.'+'db')\"", 'bash'],
    ['bash -c "cat ../nexus.db"', 'bash'],
    ['powershell -Command "Get-Content ../nexus.db-wal"', 'bash'],
    ['git status && cat nexus.db', 'bash'],
  ]
  it.each(DATA)('forbidden: %s (%s)', (c, shell) => {
    const r = cls(c, shell)
    expect(r.level, r.reasons.join('; ')).toBe('forbidden')
  })
  it('is denied for every role, including the read-only ones', async () => {
    for (const role of ['worker', 'debugger', 'planner', 'researcher', 'reviewer', 'security_reviewer'] as AgentRole[]) {
      for (const [c, shell] of DATA) {
        expect((await decide(role, shell, c)).behavior, `${role} ${shell}: ${c}`).toBe('deny')
      }
    }
  })
  it('does not trip on commit messages that merely mention it', () => {
    expect(cls('git commit -m "fix: nexus.db migration order"', 'bash').level).toBe('write')
    expect(cls('git commit -am "docs: overnight.key rotation"', 'bash').level).toBe('write')
  })
})

describe('readiness review: git config behind a value option, and Git\'s own files', () => {
  it('finds a dangerous key wherever it stands on the command line', async () => {
    const commands = [
      'git config --type bool core.fsmonitor evil',
      'git config --type=path core.hooksPath hooks',
      'git config --default x core.sshCommand evil',
      'git config --comment note alias.x "!evil"',
      'git config set --type bool core.fsmonitor evil',
      'git config --file .git/config core.pager evil',
      'git config --local --type bool filter.a.clean evil',
    ]
    for (const command of commands) {
      for (const shell of ['bash', 'powershell'] as const) {
        expect(cls(command, shell).level, `${shell}: ${command}`).not.toBe('safe')
        expect(cls(command, shell).reasons.join(' '), `${shell}: ${command}`).toMatch(/can make git run arbitrary programs|Git's own files/)
        for (const role of WRITING) expect((await decide(role, shell, command)).behavior, `${role} ${shell}: ${command}`).not.toBe('allow')
      }
    }
    // Harmless keys and reads stay as they were.
    for (const command of ['git config user.email x@y.z', 'git config --type bool core.autocrlf true', 'git config --get core.fsmonitor', 'git config --list']) {
      expect(cls(command, 'bash').reasons.join(' '), command).not.toMatch(/arbitrary programs/)
    }
  })

  it("asks before any command but git touches Git's own files: the worktree pointer, the configuration, the hooks", async () => {
    const bash = ['echo "gitdir: C:/Users/u/repo/.git" > .git', 'printf x >> .git/config', 'cp evil.sh .git/hooks/pre-commit', 'tee .git/config < x', "node -e \"require('fs').writeFileSync('.git', 'x')\" .git", 'cat .git/HEAD', 'sed -i s/a/b/ .git/config']
    const powershell = ['Set-Content -Path .git -Value "gitdir: C:/x"', "'x' | Out-File .git\\config", 'Copy-Item evil.cmd .git\\hooks\\pre-commit.cmd', 'Add-Content .git/config "[core]"']
    for (const [shell, commands] of [['bash', bash], ['powershell', powershell]] as const) {
      for (const command of commands) {
        // The interpreter-argument form is only caught when the path is a word of the command; see SECURITY.md.
        const result = cls(command, shell)
        expect(result.reasons.join(' '), `${shell}: ${command}`).toMatch(/Git's own files|\.git directory/)
        for (const role of WRITING) expect((await decide(role, shell, command)).behavior, `${role} ${shell}: ${command}`).not.toBe('allow')
      }
    }
    // Files that only start with ".git" are ordinary files, and git itself may name its directory.
    for (const command of ['echo node_modules >> .gitignore', 'cat .gitattributes', 'git --git-dir=.git status', 'ls .github/workflows']) {
      expect(cls(command, 'bash').reasons.join(' '), command).not.toMatch(/Git's own files/)
    }
  })
})

describe('readiness review: moving refs outside nexus/', () => {
  it('asks before a branch or tag is moved, overwritten or a ref is written directly', async () => {
    const asks = ['git branch -f main HEAD~3', 'git branch -M feature main', 'git branch --force release abc123', 'git tag -f v1.0.0', 'git tag -d v1.0.0', 'git update-ref refs/heads/main abc123', 'git update-ref HEAD abc123', 'git update-ref --stdin']
    for (const command of asks) {
      expect(cls(command, 'bash').level, command).not.toBe('safe')
      for (const role of WRITING) expect((await decide(role, 'bash', command)).behavior, `${role}: ${command}`).not.toBe('allow')
    }
    const free = ['git branch feature', 'git branch --list', 'git tag v1.2.3', 'git update-ref refs/heads/nexus/x/task abc123']
    for (const command of free) expect(cls(command, 'bash').reasons.join(' '), command).not.toMatch(/moves|replaces|overwrites/)
  })
})
