import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isGitWithFilters, isPlainGitPowerShell, isSafeUserGit } from '@main/modules/policies/git-pipeline'

// What an agent's text can make run AS THE USER (at low integrity) in a project whose code otherwise runs as
// the sandbox account: listed git subcommands, without the arguments that make git run a program, read or
// write a named file, or look at another repository. Every "no" here was a "yes" of the first version, found
// by the independent review of 2026-10-11; a "no" only means the command runs as the sandbox account.

const worktree = resolve('test-results', 'git-user-tests', 'worktree')
const yes = (command: string): void => expect(isGitWithFilters(command, worktree, worktree), command).toBe(true)
const no = (command: string): void => expect(isGitWithFilters(command, worktree, worktree), command).toBe(false)
const heredoc = (body: string, delimiter = "'EOF'"): string => `"$(cat <<${delimiter}\n${body}\nEOF\n)"`

describe('git as the user: what qualifies', () => {
  beforeAll(() => mkdirSync(worktree, { recursive: true }))
  afterAll(() => rmSync(resolve('test-results', 'git-user-tests'), { recursive: true, force: true }))

  it('nothing stands between git and its subcommand', () => {
    for (const command of [
      'git -C C:/Users/x/repo log',
      'git --git-dir=C:/x/.git log',
      'git --git-dir=evil hi',
      'git --git-dir=./evil --work-tree=. status',
      'git --work-tree=.. status',
      'git -c core.pager=calc log',
      'git -c alias.x=!calc x',
      'git --exec-path=C:/x log',
      'git --exec-path=. foo',
      'git --exec-path ./bin foo',
      'git -p log',
      'git --paginate log',
      'git --attr-source=HEAD log',
      'git --no-pager log',
    ])
      no(command)
  })

  it('only listed subcommands: what is unknown may be an alias or a program beside git', () => {
    for (const command of [
      'git foo',
      'git hi',
      'git grep x',
      'git grep -Ocmd x',
      'git grep -O cmd x',
      'git grep --open-files-in-pager=cmd x',
      'git config user.name x',
      'git init --template=. sub',
      'git clone . sub',
      'git worktree add ../x',
      'git submodule update --init',
      'git fetch origin',
      'git pull',
      'git push origin HEAD',
      'git remote add x https://attacker.org/r',
      'git archive -o out.zip HEAD',
      'git bundle create x HEAD',
      'git bisect run calc',
      'git difftool HEAD',
      'git mergetool',
      'git filter-branch --tree-filter calc',
      'git gc',
      'git daemon',
    ])
      no(command)
    for (const command of [
      'git status',
      'git add -A && git commit -m "a message" && git log --oneline -1',
      'git checkout -b feature && git status --short',
      'git reset --hard HEAD && git clean -fd',
      'git stash && git stash pop',
      'git diff HEAD~1 -- src/a.ts',
      'git show --stat HEAD',
      'git log -S needle --oneline',
      'git rev-parse --abbrev-ref HEAD',
      'git commit --amend --no-edit',
      'git log --oneline | head -3; git status --short',
    ])
      yes(command)
  })

  it('no argument that makes a listed subcommand run a program, read or write a named file, or look elsewhere', () => {
    for (const command of [
      'git diff --ext-diff',
      'git log --textconv',
      'git show --ext-diff HEAD',
      'git diff --no-index C:/Users/x/secret.txt README.md',
      'git diff --output=out.patch',
      'git log --output=x',
      'git diff -Oorder.txt',
      'git rebase --exec calc HEAD~1',
      'git rebase -x calc HEAD~1',
      'git rebase -i HEAD~2',
      'git commit -F C:/Users/x/secret.txt',
      'git commit --file=../outside.txt',
      'git commit -S -m signed',
      'git commit --gpg-sign -m signed',
      'git merge -s evil other',
      'git merge --strategy=evil other',
      'git tag -F notes.txt v1',
      'git tag v1',
      'git blame --contents C:/Users/x/secret.txt README.md',
      'git add --pathspec-from-file=C:/Users/x/list.txt',
      'git commit -e -m x',
      'git add -p',
    ])
      no(command)
    // After `--` everything is a path in the worktree's index, whatever it looks like.
    yes('git add -- --exec')
    yes('git log -- -Ocmd')
  })

  it('a commit message as a quoted here-document is text; no other substitution is taken', () => {
    yes(`git add -A && git commit -m ${heredoc('Fix the counter\n\nIt added $2 `twice`; now (once).')}`)
    yes(`git commit -m ${heredoc('One line')} && git status --short`)
    // An unquoted delimiter lets the shell expand the text; anything else in the substitution is another command.
    no(`git commit -m ${heredoc('$(calc)', 'EOF')}`)
    no('git commit -m "$(calc)"')
    no(`git commit -m "$(cat <<'EOF'\nx\nEOF\n; calc)"`)
    no(`git commit -m ${heredoc('x')}\ncalc`)
    no(`git commit -m ${heredoc('x')}; calc`)
  })

  it('in PowerShell: git alone, in words PowerShell reads as written', () => {
    for (const command of ['git status --short; git log --oneline -1', "git commit -m 'a message'", 'git add -A']) expect(isPlainGitPowerShell(command), command).toBe(true)
    for (const command of [
      'git status | Select-Object -First 1',
      'git log; Get-Content .git',
      'git commit -m "x $env:USERNAME"',
      'git grep -Ocmd x',
      'git --exec-path=. foo',
      'git -c alias.x=!calc x',
      'git status; & calc',
      'git add src\\a.ts',
      'git log > out.txt',
      'git foo',
      'git commit -m $(calc)',
      'git status\ncalc',
      'git log @args',
    ])
      expect(isPlainGitPowerShell(command), command).toBe(false)
  })

  it('judges the words after git by themselves', () => {
    expect(isSafeUserGit(['status'])).toBe(true)
    expect(isSafeUserGit([])).toBe(false)
    expect(isSafeUserGit(['-c', 'x=y', 'status'])).toBe(false)
    expect(isSafeUserGit(['log', '--format=%H %s'])).toBe(true)
    expect(isSafeUserGit(['commit', '-am', 'x'])).toBe(true)
    expect(isSafeUserGit(['commit', '-aF', 'x'])).toBe(false)
    expect(isSafeUserGit(['commit', '--no-edit', '--amend'])).toBe(true)
  })
})
