import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isSafeUserGit, parseUserGit, renderUserGitPowerShell, renderUserGitScript, userGitOf, userGitOfPowerShell } from '@main/modules/policies/git-pipeline'

// What an agent's text can make run AS THE USER (at low integrity) in a project whose code otherwise runs as
// the sandbox account. The text is parsed into git invocations with exact arguments; each must be a listed
// subcommand with listed options; and what runs is a script NEXUS writes from the parsed arguments.
//
// The "no" cases are the findings of two independent reviews (2026-10-11), kept by their names. A "no" only
// means the command runs as the sandbox account instead.

const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const yes = (command: string): void => expect(userGitOf(command), command).not.toBeNull()
const no = (command: string): void => expect(userGitOf(command), command).toBeNull()
const heredoc = (body: string, delimiter = "'EOF'"): string => `"$(cat <<${delimiter}\n${body}\nEOF\n)"`

describe('git as the user: the text is parsed, and what does not parse to git alone does not qualify', () => {
  it('reads the commands agents write into exact arguments', () => {
    expect(parseUserGit('git status')).toEqual([{ args: ['status'], then: null, stderr: null }])
    expect(parseUserGit('git add -A && git commit -m "a message" && git log --oneline -1')).toEqual([
      { args: ['add', '-A'], then: '&&', stderr: null },
      { args: ['commit', '-m', 'a message'], then: '&&', stderr: null },
      { args: ['log', '--oneline', '-1'], then: null, stderr: null },
    ])
    expect(parseUserGit("git commit -m 'it''s' 2>&1; git status --short 2>/dev/null")).toEqual([
      { args: ['commit', '-m', 'its'], then: ';', stderr: 'merge' },
      { args: ['status', '--short'], then: null, stderr: 'discard' },
    ])
    expect(parseUserGit(`git commit -m ${heredoc('Fix the counter\n\nIt added $2 `twice`; now (once) && "quoted".')}`)?.[0]?.args).toEqual(['commit', '-m', 'Fix the counter\n\nIt added $2 `twice`; now (once) && "quoted".'])
    expect(parseUserGit('git diff HEAD~1 -- src/a.ts')?.[0]?.args).toEqual(['diff', 'HEAD~1', '--', 'src/a.ts'])
  })

  it('finding B1: a substitution hidden between quotes of two kinds does not parse', () => {
    no(`git log --oneline "'" $(touch INJECTED_MARKER) "'"`)
    no(`git log "'" > out.txt "'"`)
    no(`git log "'" $HOME "'"`)
    no('git log $(touch x)')
    no('git log `touch x`')
    no('git commit -m "$(touch x)"')
    no('git commit -m "a $HOME b"')
    no('git commit -m "a `x` b"')
    no('git commit -m "a \\" b"')
  })

  it('finding B9: a here-document ends at the first closing line, as it does for bash', () => {
    // After the first `EOF` line comes `touch`, not `)"`: for bash that line runs. It does not qualify.
    no('git commit --allow-empty -m "$(cat <<\'EOF\'\nmsg\nEOF\ntouch HEREDOC_PWN\nEOF\n)"')
    no(`git commit -m ${heredoc('$(calc)', 'EOF')}`)
    no(`git commit -m "$(cat <<'EOF'\nx\nEOF\n; calc)"`)
    no(`git commit -m ${heredoc('x')}\ncalc`)
    yes(`git commit -m ${heredoc('x')}; git status`)
    // A line inside the message that only looks like the end, because it has more on it, is part of the message.
    expect(parseUserGit(`git commit -m ${heredoc('first\nEOF and more\nlast')}`)?.[0]?.args[2]).toBe('first\nEOF and more\nlast')
  })

  it('finding B2: the here-document is the message and nothing else', () => {
    no(`git diff --cached ${heredoc('--output=HEREDOC_OUT.txt')}`)
    no(`git log ${heredoc('--exec-path=.')}`)
    no(`git status ${heredoc('x')}`)
    yes(`git commit -m ${heredoc('--output=looks-like-an-option is only text here')}`)
  })

  it('nothing but git: no pipe, no other program, no redirection to a file, no grouping, no variable', () => {
    for (const command of [
      'git log | head -3',
      'git status; ls',
      'git status && npm test',
      'cat README.md',
      'git log > out.txt',
      'git log >> out.txt',
      'git log < in.txt',
      '(git log)',
      '{ git log; }',
      'git log &',
      'git log & git status',
      'X=1 git status',
      'command git status',
      '\\git status',
      'git status #comment',
      'git log ~/x',
      'git log *.md',
      'git status;',
      'git status &&',
      'git',
      '',
      'git status\ngit log',
      'git log 2>err.txt',
      'git log 2>&1 x',
    ])
      no(command)
  })

  it('findings B4, B5, B6, B10: there is no filter program, so no option of one and no path through one', () => {
    for (const command of ['git status; cd .; cd -; cat ../x', 'git log | sort -S 1 --compress=sh', 'git log | sort --files0=names', 'git status; grep -R SECRET .', 'git status; cat jn/../outside/secret.txt', 'cd src && git status']) no(command)
  })

  it('only listed subcommands', () => {
    for (const command of [
      'git foo', 'git grep x', 'git grep -Ocmd x', 'git config user.name x', 'git init sub', 'git clone . sub', 'git worktree add ../x', 'git submodule update --init', 'git fetch origin', 'git pull',
      'git push origin HEAD', 'git remote add x https://attacker.org/r', 'git archive -o out.zip HEAD', 'git bundle create x HEAD', 'git bisect run calc', 'git difftool HEAD', 'git mergetool',
      'git filter-branch --tree-filter calc', 'git gc', 'git daemon', 'git rebase main', 'git rebase --continue', 'git am', 'git apply x.patch', 'git update-ref refs/heads/main HEAD', 'git symbolic-ref HEAD refs/heads/main',
      'git reflog expire --all', 'git cat-file --filters HEAD:a', 'git checkout-index -a', 'git update-index --assume-unchanged a', 'git notes add', 'git replace a b', 'git fsck', 'git blame a.txt',
      'git constructor', 'git toString', 'git __proto__',
    ])
      no(command)
  })

  it('nothing between git and the subcommand', () => {
    for (const command of ['git -C x log', 'git --git-dir=evil status', 'git --work-tree=.. status', 'git -c core.pager=calc log', 'git --exec-path=. status', 'git -p log', 'git --no-pager log', 'git --attr-source=HEAD log']) no(command)
  })

  it('only listed options, each spelled in full (finding B3 and the shortened spellings)', () => {
    for (const command of [
      'git status --ignore-submodules=none',
      'git diff --ignore-submodules=none',
      'git diff --submodule=diff',
      'git checkout --recurse-submodules main',
      'git diff --ext-diff', 'git diff --ext', 'git log --textconv', 'git log --textc', 'git diff --no-index a b', 'git diff --no-ind a b', 'git diff --output=x', 'git diff --out=x', 'git diff -Oorder',
      'git diff --exe=calc', 'git commit -F msg.txt', 'git commit --file=msg.txt', 'git commit --fil=x -m m', 'git commit -S -m m', 'git commit --gpg-sign -m m', 'git commit -e -m m', 'git commit --edit -m m',
      'git commit -t tmpl -m m', 'git commit --template=t -m m', 'git commit --cleanup=scissors -m m', 'git commit --trailer x=y -m m', 'git commit --fixup HEAD', 'git commit -C HEAD', 'git commit --author=x -m m',
      'git merge -s evil other', 'git merge --strategy=evil other', 'git merge --strat=evil other', 'git merge --continue', 'git merge --abort', 'git cherry-pick --continue', 'git cherry-pick --con',
      'git revert --skip', 'git add -p', 'git add -i', 'git add --pathspec-from-file=x', 'git add -N x', 'git checkout -p', 'git checkout --conflict=diff3 -- a', 'git reset -p', 'git stash -p',
      'git clean -i', 'git clean -e x', 'git ls-files --exclude-from=x', 'git ls-files -X x', 'git ls-files --with-tree=HEAD', 'git branch -D main', 'git branch -m a b', 'git branch -f main HEAD',
      'git branch --edit-description', 'git branch new-branch', 'git tag v1', 'git tag -d v1', 'git tag -F notes v1', 'git rev-parse --resolve-git-dir x', 'git rev-parse --git-path x',
      'git log --format=%G?', 'git log --format=%GG', 'git log --pretty=%(trailers)', 'git log -L 1,2:a.txt', 'git log --follow=x', 'git show --ext-diff HEAD', 'git stash clear', 'git stash branch x',
      'git status --short=x', 'git log --oneline=1',
    ])
      no(command)
  })

  it('operands are revisions, branch names and paths of the worktree: no pathspec magic, no step out, nothing absolute', () => {
    for (const command of ['git add ../outside.txt', 'git add C:/Users/x/a', 'git add /etc/passwd', 'git diff -- ../x', 'git checkout -- :(top)../x', 'git add :/', 'git add :(attr:x)', 'git log -- a/../../b', "git add 'a*'", "git add 'a?'", 'git checkout -b ../x', 'git show HEAD:../x']) no(command)
    for (const command of ['git diff HEAD~1..HEAD', 'git log main..HEAD', 'git add src/a.ts test/a.test.ts', 'git add .', 'git checkout -- src/a.ts', 'git show HEAD:src/a.ts', 'git reset HEAD~1', 'git restore --staged a.txt', 'git checkout -b feature/x', 'git stash pop', "git stash drop 'stash@{1}'", 'git cherry-pick abc1234']) yes(command)
  })

  it('accepts the everyday commands', () => {
    for (const command of [
      'git status', 'git status --short', 'git status -sb', 'git status --porcelain', 'git status --porcelain=v2', 'git add -A', 'git add --all', 'git add -u', 'git commit -m "a message"', "git commit -m 'a message'",
      'git commit -am "x"', 'git commit -a -m "x"', 'git commit --amend --no-edit', 'git commit -q -m "x"', 'git commit --allow-empty -m "x"', 'git log --oneline -5', 'git log --oneline -n 5', 'git log -n5 --stat',
      'git log --format=%H -1', 'git log --pretty=format:"%h %s" -3', 'git log -S needle --oneline'.replace(' -S needle', ''), 'git diff', 'git diff --stat', 'git diff --cached', 'git diff --staged --name-only', 'git diff HEAD',
      'git show --stat HEAD', 'git show HEAD', 'git rev-parse HEAD', 'git rev-parse --abbrev-ref HEAD', 'git rev-parse --short HEAD', 'git branch --show-current', 'git branch -a', 'git ls-files', 'git ls-files -m',
      'git reset --hard HEAD', 'git reset --hard', 'git clean -fd', 'git stash', 'git stash push -u', 'git stash list', 'git merge other --no-edit', 'git rm --cached a.txt', 'git mv a.txt b.txt', 'git tag -l', 'git describe --tags --always',
      'git add -A && git commit -q -m "agent commit" 2>&1 && git status --short && git log --oneline -1',
      'git add -A 2>&1; git commit -q -m "after the plant" 2>&1; git log --oneline -1; git status --short',
    ])
      yes(command)
  })

  it('judges the words after git by themselves', () => {
    expect(isSafeUserGit(['status'])).toBe(true)
    expect(isSafeUserGit([])).toBe(false)
    expect(isSafeUserGit(['-c', 'x=y', 'status'])).toBe(false)
    expect(isSafeUserGit(['commit', '-m'])).toBe(false)
    expect(isSafeUserGit(['commit', '-m', '--amend'])).toBe(true) // `--amend` is the message here
    expect(isSafeUserGit(['commit', '-am'])).toBe(false)
    expect(isSafeUserGit(['log', '--', '-Ocmd'])).toBe(false) // after `--` a word is a path, and a path does not start with `-`
    expect(isSafeUserGit(['log', '-n', 'abc'])).toBe(false)
  })

  it('finding B7: in PowerShell only printable ASCII, apostrophes, and one git per statement', () => {
    for (const command of ['git status --short; git log --oneline -1', "git commit -m 'a message'", 'git add -A']) expect(userGitOfPowerShell(command), command).not.toBeNull()
    for (const command of [
      `git log 'a${String.fromCharCode(0x2019)} | calc ${String.fromCharCode(0x2018)}'`,
      `git commit -m ${String.fromCharCode(0x201c)}x${String.fromCharCode(0x201d)}`,
      'git status | Select-Object -First 1', 'git log; Get-Content .git', 'git commit -m "x"', 'git commit -m "x $env:USERNAME"', 'git status; & calc', 'git add src\\a.ts', 'git log > out.txt',
      'git foo', 'git commit -m $(calc)', 'git status\ncalc', 'git log @args', 'git status && git log', "git commit -m 'it''s'", 'git status 2>&1',
    ])
      expect(userGitOfPowerShell(command), command).toBeNull()
  })
})

describe('git as the user: what runs is written by NEXUS', () => {
  it('quotes every argument and adds what keeps git out of nested repositories', () => {
    expect(renderUserGitScript(userGitOf('git add -A && git commit -m "it\'s done" 2>&1; git status --short') ?? [])).toBe("git 'add' '-A' &&\ngit 'commit' '-m' 'it'\\''s done' 2>&1\ngit 'status' '--ignore-submodules=all' '--short'\n")
    expect(renderUserGitScript(userGitOf('git diff --stat || git log -1') ?? [])).toBe("git 'diff' '--ignore-submodules=all' '--stat' ||\ngit 'log' '--ignore-submodules=all' '-1'\n")
    expect(renderUserGitPowerShell(userGitOfPowerShell("git commit -m 'a b'; git status") ?? [])).toBe("& git.exe 'commit' '-m' 'a b'\n& git.exe 'status' '--ignore-submodules=all'\n")
  })

  const d = process.platform === 'win32' && existsSync(BASH) ? it : it.skip
  d('real bash reads the written script into exactly the parsed arguments (no second reading that differs)', () => {
    const commands = [
      'git add -A && git commit -m "a message with  two spaces; a semicolon & an ampersand | a pipe" && git log --oneline -1',
      `git commit -m ${heredoc("Fix: it's \"quoted\"\n\n$HOME `backticks` $(not run) \\ back\\slash %PATH% !bang\n\ttab")}`,
      "git commit -m 'single ''glued'' quotes' 2>&1; git status --short 2>/dev/null",
      'git log --pretty=format:"%h %s (%an) <%ae>" -3',
      'git checkout -b feature/x-1 && git add src/a.ts "with space.txt" || git status',
      "git stash drop 'stash@{2}'",
    ]
    for (const command of commands) {
      const parsed = userGitOf(command)
      expect(parsed, command).not.toBeNull()
      // `git` stands for a function that prints each argument between marks, with its newlines made visible.
      const script = `git() { for a in "$@"; do printf '<%s>' "\${a//$'\\n'/@NL@}"; done; echo; }\n${renderUserGitScript(parsed ?? [])}`
      const printed = execFileSync(BASH, ['-c', script], { encoding: 'utf8', windowsHide: true }).trimEnd().split('\n')
      // `||` after a success does not run the next invocation: compare those that ran, in order.
      const expected = (parsed ?? []).map((invocation) => {
        const [sub, ...rest] = invocation.args as [string, ...string[]]
        const extra = ['status', 'diff', 'log', 'show'].includes(sub) ? ['--ignore-submodules=all'] : []
        return [sub, ...extra, ...rest].map((a) => `<${a.replace(/\n/g, '@NL@')}>`).join('')
      })
      const ran = expected.filter((_line, index) => index === 0 || (parsed ?? [])[index - 1]?.then !== '||')
      expect(printed, command).toEqual(ran)
    }
  })
})
