import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ExecutionBroker } from '@main/modules/isolation/execution-broker'
import { Launcher } from '@main/modules/isolation/launcher'
import { readSandboxAccount } from '@main/modules/isolation/sandbox-account'
import { UNSUPPORTED_SYNTAX_EXIT } from '@main/modules/isolation/shell-adapter'
import { mirrorTools } from '@main/modules/isolation/tools'
// @ts-expect-error a build script without types
import { buildLauncher } from '../../../scripts/build-launcher.mjs'

/**
 * 0.8: what the agent's Bash capability means under the isolated profile. The shell there is busybox ash, running
 * inside the AppContainer; it is not bash. This file is the list of what an agent's commands rely on and get, and
 * of what they do not get: a bash-only construct is refused as a whole, with a message that names it, and nothing
 * of the command has run. There is no second shell behind the first, inside the containment or outside.
 */

const account = process.platform === 'win32' ? readSandboxAccount() : null
const SCRATCH = resolve('test-results', 'shell-semantics')

describe.runIf(account !== null)('the shell of the isolated profile (busybox ash in the AppContainer)', () => {
  let broker: ExecutionBroker
  let worktree: string
  let usable = false

  beforeAll(async () => {
    if (account === null) return
    rmSync(SCRATCH, { recursive: true, force: true })
    const launcher = new Launcher({ executable: buildLauncher(join(SCRATCH, 'native')) as string, specDir: join(SCRATCH, 'specs') })
    const state = mirrorTools({ sandboxRoot: account.root, userProfile: homedir(), path: process.env['PATH'] ?? '', names: ['node'] })
    broker = new ExecutionBroker({ launcher, sandboxDir: join(SCRATCH, 'sandbox'), account: () => account, baseEnv: () => process.env, toolPath: (profile, path) => (profile === 'ISOLATED' ? state.path : path), posixShell: () => resolve('vendor', 'busybox', 'busybox.exe') })
    usable = (await broker.verify('ISOLATED')).available
    worktree = join(account.root, 'worktrees', 'isolation-tests', 'shell-semantics')
    rmSync(worktree, { recursive: true, force: true })
    mkdirSync(worktree, { recursive: true })
  }, 120_000)

  async function sh(command: string): Promise<{ exit: number | null; out: string; err: string }> {
    const wrapped = await broker.containShell({ profile: 'ISOLATED', projectId: 'isolation-tests', sessionKey: 'shell-semantics', worktree, cwd: worktree, shell: 'bash', command, timeoutMs: 60_000 })
    if (!wrapped.ok) throw new Error(wrapped.reason)
    const r = spawnSync(wrapped.file, wrapped.args, { encoding: 'utf8', windowsHide: true, timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] })
    broker.releaseSpec(wrapped.specPath)
    return { exit: r.status, out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr.replace(/\r\n/g, '\n') }
  }

  it('the isolated profile holds here, so that what follows was run inside it', () => {
    expect(usable, JSON.stringify(broker.status('ISOLATED'))).toBe(true)
  })

  // [what an agent writes, what must come out]
  const SUPPORTED: [string, string, string][] = [
    ['a pipe', `printf 'b\\na\\n' | sort | tr a-z A-Z`, 'A\nB\n'],
    ['&& and ||', `true && echo yes || echo no; false && echo yes || echo no`, 'yes\nno\n'],
    ['the exit status of the last command and $?', `(exit 7); echo "rc=$?"`, 'rc=7\n'],
    ['command substitution, nested', `echo "n=$(echo $(printf '%s' 4)2)"`, 'n=42\n'],
    ['arithmetic', `echo $((6 * 7)) $((10 % 3))`, '42 1\n'],
    ['single and double quotes, spaces kept', `x='a  b'; echo "$x" '$x'`, 'a  b $x\n'],
    ['a here-document, expanded and literal', `v=1; cat <<A\nx$v\nA\ncat <<'B'\ny$v\nB`, 'x1\ny$v\n'],
    ['redirections: > >> 2>&1 < and /dev/null', `echo one > f.txt; echo two >> f.txt; ls nope 2>/dev/null; (echo e >&2) 2>&1 | tr e E; wc -l < f.txt | tr -d ' '`, 'E\n2\n'],
    ['for, while, case, if', `for i in 1 2 3; do case $i in 2) continue;; esac; printf '%s' "$i"; done; n=0; while [ $n -lt 2 ]; do n=$((n + 1)); done; if [ $n -eq 2 ]; then echo " n=$n"; fi`, '13 n=2\n'],
    ['functions and local', `f() { local a=in; echo "$a $1"; }; a=out; f arg; echo "$a"`, 'in arg\nout\n'],
    ['[[ ]] with patterns and &&', `s=hello.ts; [[ $s == *.ts && -n $s ]] && echo ts`, 'ts\n'],
    ['parameter expansion', `p=src/a/b.test.ts; echo "\${p##*/} \${p%.ts} \${p/a\\/b/x} \${none:-dflt} \${#p}"`, 'b.test.ts src/a/b.test src/x.test.ts dflt 15\n'],
    ["$'…' strings", `printf '%s' $'a\\tb' | od -c | head -1 | tr -s ' '`, '0000000 a \\t b\n'],
    ['export and a child that reads it', `export NX_T=seen; sh -c 'echo "$NX_T"'`, 'seen\n'],
    ['set -e stops at the first failure', `set -e; echo before; false; echo after`, 'before\n'],
    ['globbing', `mkdir -p g && touch g/a.js g/b.js g/c.txt && echo g/*.js`, 'g/a.js g/b.js\n'],
    ['cd and relative paths, pwd', `mkdir -p d/e && cd d/e && pwd | sed 's|.*/shell-semantics|~|'`, '~/d/e\n'],
    ['the usual tools', `printf 'x 1\\ny 2\\nx 3\\n' > t.txt; grep -c x t.txt; awk '{ s += $2 } END { print s }' t.txt; sed -n '2p' t.txt; cut -d' ' -f1 t.txt | sort -u | xargs; head -1 t.txt | wc -c | tr -d ' '; find . -name 't.txt' | head -1; basename "$PWD"; test -f t.txt && echo is-file; rm -f t.txt; test -f t.txt || echo gone`, '2\n6\ny 2\nx y\n4\n./t.txt\nshell-semantics\nis-file\ngone\n'],
    ['a background job and wait', `(sleep 1; echo late > bg.txt) & wait; cat bg.txt`, 'late\n'],
    ['node, started by name, with a pipe to it', `echo '{"a":5}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).a+1))"`, '6\n'],
    ['node starting a child of its own with a pipe', `node -e "console.log(require('child_process').execSync('echo child').toString().trim())"`, 'child\n'],
    ['process substitution, which this shell has', `cat <(echo a) <(echo b); while read -r l; do echo "got $l"; done < <(printf 'x\\n')`, 'a\nb\ngot x\n'],
    ['bash by name: it is this same shell, inside the containment', `bash -c 'echo "from $0"'`, 'from bash\n'],
    ['a script file with a sh shebang', `printf '#!/bin/sh\\necho from-script "$1"\\n' > s.sh; sh s.sh a; chmod +x s.sh; ./s.sh b`, 'from-script a\nfrom-script b\n'],
  ]
  for (const [what, command, expected] of SUPPORTED) {
    it(`runs ${what}`, async () => {
      const r = await sh(command)
      expect(r.out, `${command}\n--- stderr\n${r.err}`).toBe(expected)
    }, 120_000)
  }

  it("gives the command's own exit code", async () => {
    expect((await sh('exit 3')).exit).toBe(3)
    expect((await sh('true')).exit).toBe(0)
    expect((await sh('no-such-program-nx')).exit).toBe(127)
  }, 120_000)

  // Bash-only syntax: the whole command is refused before any of it runs.
  const REFUSED: [string, string][] = [
    ['an array', `touch ran-array.txt; a=(1 2 3); echo "\${a[1]}"`],
    ['an associative array declaration with values', `touch ran-assoc.txt; declare -A m=([k]=v)`],
  ]
  for (const [what, command] of REFUSED) {
    it(`refuses ${what} as a whole, says why, and runs none of it`, async () => {
      const r = await sh(command)
      expect(r.exit, `${r.out}\n${r.err}`).toBe(UNSUPPORTED_SYNTAX_EXIT)
      expect(r.err).toContain('NEXUS: this command was not run')
      expect(r.err).toContain('POSIX shell (busybox ash), not bash')
      expect(r.out).toBe('')
      const marker = /touch (\S+);/.exec(command)?.[1] as string
      expect(existsSync(join(worktree, marker)), `${marker} was made: part of the command ran`).toBe(false)
    }, 120_000)
  }

  it('fails, inside the containment and with a message, on what parses and does not exist: an expansion of bash only, an array given to bash by name', async () => {
    const byName = await sh(`bash -c 'a=(1 2); echo never'`)
    expect(byName.exit).not.toBe(0)
    expect(byName.err).toMatch(/syntax error/)
    expect(byName.out).not.toContain('never')
    const expansion = await sh(`x=abc; echo "\${x^^}"`)
    expect(expansion.exit).not.toBe(0)
    expect(expansion.err).toMatch(/bad substitution|syntax error/)
    expect(expansion.out).not.toContain('ABC')
  }, 120_000)

  it('is the contained account in the AppContainer, not the user: the shell itself, and what it starts', async () => {
    const r = await sh(`whoami; node -e "console.log(require('os').userInfo().username)"; node -e "require('dns').lookup('dns.msftncsi.com', (e) => console.log(e ? 'no-name' : 'name'))"`)
    expect(r.out.toLowerCase().split('\n').slice(0, 2), r.err).toEqual([account?.account.toLowerCase(), account?.account.toLowerCase()])
    expect(r.out).toContain('no-name')
    expect(r.out.toLowerCase()).not.toContain((process.env['USERNAME'] ?? 'no-user').toLowerCase())
  }, 120_000)
})
