import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isGitWithFilters } from '@main/modules/policies/git-pipeline'

// Which bash commands count as "git with nothing but text filters": they run where git can read the
// repository (as the user, at low integrity), so everything not plainly harmless must be a "no".

const worktree = resolve('test-results', 'git-pipeline-tests', 'worktree')
const yes = (command: string, cwd = worktree): void => expect(isGitWithFilters(command, worktree, cwd), command).toBe(true)
const no = (command: string, cwd = worktree): void => expect(isGitWithFilters(command, worktree, cwd), command).toBe(false)

describe('git with text filters', () => {
  beforeAll(() => {
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, 'README.md'), 'x')
  })
  afterAll(() => rmSync(resolve('test-results', 'git-pipeline-tests'), { recursive: true, force: true }))

  it('accepts what agents write around git', () => {
    yes('git log --oneline | head -3; git status --short')
    yes('git status')
    yes('git diff --stat | tail -n 5')
    yes('git ls-files | grep -c test')
    yes("git log --format='%h %s' | grep -i 'fix$' | wc -l")
    yes('git status 2>&1 | head -20')
    yes('git rev-parse HEAD 2>/dev/null && echo "clean tree"')
    yes('cd src && git ls-files | sort | uniq')
    yes('git ls-files && cat README.md')
    yes('git branch --show-current; ls src; pwd')
  })

  it('needs git in it, and nothing but git and filters', () => {
    no('cat README.md')
    no('git status && npm test')
    no('git log | node -e "x"')
    no('git log | xargs rm')
    no('git log | sh')
    no('git log | tee out.txt')
    no('git log | awk "{print}"')
    no('git log | sed -n 1p')
  })

  it('gives the shell nothing to expand, substitute, redirect or group', () => {
    no('git log | head -$N')
    no('git log $(cat x)')
    no('git log `whoami`')
    no('git status > out.txt')
    no('git status >> out.txt')
    no('git log | cat < /etc/passwd')
    no('git log | cat ~/.ssh/id_rsa')
    no('git log | cat *.md')
    no('(git log)')
    no('git log | { cat; }')
    no('git log & cat README.md')
    no('git log | grep "a$b"')
    no('git log \\\n| head')
    no('git log | head\nrm -rf x')
    no('git log | cat "a\\"b"')
  })

  it('keeps every file a filter is named inside the worktree', () => {
    no('git log | cat ../outside.txt')
    no('git log | cat C:\\Windows\\win.ini')
    no('git log | cat /c/Windows/win.ini')
    no('git log | cat /etc/passwd')
    no('git status; ls ..')
    no('cd .. && git status')
    no('cd src/../.. && git status')
    no('git log | head -3 C:/Users/x/secret.txt')
    // A Windows path with backslashes is not what bash would read; with slashes it is the file.
    no(`git log | cat ${join(worktree, 'README.md')}`)
    yes(`git log | cat ${join(worktree, 'README.md').split('\\').join('/')}`)
    yes('git log | cat src/../README.md')
  })

  it('refuses the options that make a filter write, read a list, run a program or never end', () => {
    no('git log | sort -o out.txt')
    no('git log | sort -uo out.txt')
    no('git log | sort --output=out.txt')
    no('git log | sort --compress-program=calc')
    no('git log | sort -T C:/Users')
    no('git log | grep -f patterns.txt')
    no('git log | grep --file=patterns.txt')
    no('git log | uniq in.txt out.txt')
    no('git log | wc --files0-from=list')
    no('git log | tail -f')
    no('git log | cut -d: -f1')
  })

  it('does not let git be pointed somewhere else', () => {
    no('git -C C:/Users/x/repo log | head')
    no('git --git-dir=C:/x/.git log | head')
    no('git --work-tree=.. status | head')
    no('git -c core.pager=calc log | head')
    no('git --exec-path=C:/x log | head')
  })

  it('starts where the shell is when that is inside the worktree', () => {
    yes('git status | head; ls ..', join(worktree, 'src'))
    no('git status | head; ls ../..', join(worktree, 'src'))
  })
})
