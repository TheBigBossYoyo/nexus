/**
 * 0.8: which shell commands may run where git can change a ref of the user's repository: as the user, at low
 * integrity, instead of as the sandbox account. That place has the user's network and reads what the user's
 * low-integrity processes read, so what runs there must be git doing a known thing, and nothing else.
 *
 * Two decisions shape this file, both taken after independent reviews found the earlier versions wanting
 * (2026-10-11: first the command classifier's "no finding" was taken for "git alone"; then a validator that
 * read the command as text let through a command substitution hidden by an odd pairing of quotes, and a
 * here-document that ended earlier for the shell than for the validator):
 *
 *  1. The agent's text is never what runs. It is parsed here into git invocations, each a list of arguments,
 *     joined by `&&`, `||` or `;`. NEXUS then writes the script itself, quoting every argument. If the text
 *     cannot be parsed into exactly that, it does not qualify. So there is no second reading of the text by a
 *     shell that could differ from this one.
 *  2. What an invocation may be is a list, not a list of exceptions: a subcommand from a fixed set, and for
 *     each subcommand the options it may take, spelled out in full. Anything else does not qualify: an
 *     unknown subcommand, an unknown option, a shortened option, an option with a value where none is listed.
 *
 * Nothing but git qualifies: no pipe, no filter program, no redirection except the two that merge or discard
 * the error stream. `git log | head -3` runs as the sandbox account, which can read the repository.
 *
 * "Does not qualify" is not a refusal: the command then runs under the session's own profile, where a
 * ref-changing git is told to be run as a command of its own.
 */

export interface UserGitInvocation {
  /** The arguments after `git`, exactly as git will get them. */
  args: string[]
  /** What joins this invocation to the next. */
  then: '&&' | '||' | ';' | null
  /** `2>&1` or `2>/dev/null` after the invocation. */
  stderr: 'merge' | 'discard' | null
}

/** Words that may stand unquoted: letters, digits and the marks git's revisions and paths use. No shell mark is among them. */
const BARE = /^[A-Za-z0-9_@%+=:,./^~-]$/
/** Control characters other than tab and newline. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/

/**
 * Reads the command as a sequence of git invocations, or null when it is anything else. Quoting is read the
 * way bash reads it, for the subset accepted: a single-quoted string is literal; a double-quoted string is
 * literal too because nothing bash would expand in it is accepted (`$`, a backtick, a backslash, `!`);
 * outside quotes only the characters of BARE make a word.
 */
export function parseUserGit(command: string): UserGitInvocation[] | null {
  if (command.length > 8000) return null
  const text = command.replace(/\r\n/g, '\n')
  const out: UserGitInvocation[] = []
  let words: string[] = []
  let word = ''
  let has = false
  let stderr: UserGitInvocation['stderr'] = null
  let i = 0
  const endWord = (): void => {
    if (has) words.push(word)
    word = ''
    has = false
  }
  const endInvocation = (then: UserGitInvocation['then']): boolean => {
    endWord()
    if (words.length < 2 || words[0] !== 'git') return false
    out.push({ args: words.slice(1), then, stderr })
    words = []
    stderr = null
    return true
  }
  while (i < text.length) {
    const ch = text[i] as string
    // Nothing follows a redirection but the end of the invocation.
    if (stderr !== null && ch !== ' ' && ch !== '\t' && ch !== ';' && ch !== '&' && ch !== '|') return null
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return null
      const inner = text.slice(i + 1, end)
      if (CONTROL.test(inner)) return null
      word += inner
      has = true
      i = end + 1
      continue
    }
    if (ch === '"') {
      // The commit message as a quoted here-document: `"$(cat <<'EOF'` newline, the text, a line that is the
      // word alone, `)"`. bash ends such a document at the FIRST line that is the word alone, and so does this.
      const here = /^"\$\(cat <<'([A-Za-z_][A-Za-z0-9_]*)'\n/.exec(text.slice(i))
      if (here !== null) {
        if (has) return null
        const start = i + here[0].length
        const closing = `\n${here[1]}\n`
        // The text may be empty: then the closing line follows the opening one directly.
        const empty = text.startsWith(`${here[1]}\n`, start)
        const bodyEnd = empty ? start - 1 : text.indexOf(closing, start)
        if (bodyEnd < 0) return null
        const after = bodyEnd + closing.length
        const tail = /^[ \t]*\)"/.exec(text.slice(after))
        if (tail === null) return null
        const body = empty ? '' : text.slice(start, bodyEnd)
        if (CONTROL.test(body)) return null
        // Only as the message: the word right after `-m`.
        const before = words[words.length - 1]
        if (before !== '-m') return null
        word = body
        has = true
        i = after + tail[0].length
        continue
      }
      const end = text.indexOf('"', i + 1)
      if (end < 0) return null
      const inner = text.slice(i + 1, end)
      if (/[$`\\!]/.test(inner) || CONTROL.test(inner)) return null
      word += inner
      has = true
      i = end + 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      endWord()
      i += 1
      continue
    }
    if (ch === '2' && !has && (text.startsWith('2>&1', i) || text.startsWith('2>/dev/null', i))) {
      endWord()
      const merge = text.startsWith('2>&1', i)
      stderr = merge ? 'merge' : 'discard'
      i += merge ? 4 : 11
      continue
    }
    if (ch === ';') {
      if (!endInvocation(';')) return null
      i += 1
      continue
    }
    if (ch === '&' || ch === '|') {
      if (text[i + 1] !== ch) return null
      if (!endInvocation(ch === '&' ? '&&' : '||')) return null
      i += 2
      continue
    }
    if (!BARE.test(ch)) return null
    // `~` begins a home directory only where a word begins; `HEAD~1` is a commit.
    if (ch === '~' && !has) return null
    word += ch
    has = true
    i += 1
  }
  endWord()
  if (words.length > 0 && !endInvocation(null)) return null
  if (out.length === 0 || out.length > 12) return null
  // A trailing operator leaves the last invocation open.
  if ((out[out.length - 1] as UserGitInvocation).then !== null) return null
  return out
}

/**
 * How an option is taken: alone, or with a value that must pass a test. Where the value stands is fixed, because
 * git and this file must agree on it: a long option takes its value after `=` and never as the next word (git
 * reads `--format --output=x` as two options, the second of which writes a file; found by the second audit); a
 * short option takes the next word, which git always consumes for the ones listed here (`-m`, `-n`, `-b`, `-B`,
 * `-c`, `-s` of restore). `-U` takes its number attached only (`-U5`): alone it has a default, and git would
 * read the next word as a revision.
 */
type OptionRule = true | ((value: string) => boolean)
interface SubcommandRule {
  options: Record<string, OptionRule>
  /** Options listed as taking no value that may also be given one: `--porcelain`, `--porcelain=v2`. */
  optional?: Record<string, (value: string) => boolean>
  /** Clusters of single letters, each of which is a listed short option without a value. */
  letters?: string
  /** How many words that are not options (revisions, paths, a branch name) are taken at most. */
  operands: number
  /** A test every operand must pass, in place of the general one. */
  operand?: (value: string, index: number) => boolean
}

/** A revision, a branch name or a path of the worktree: not an option, no pathspec magic, no step out of the worktree, nothing absolute. */
function plainOperand(v: string): boolean {
  if (v === '' || v.length > 500) return false
  if (v.startsWith('-') || v.startsWith(':') || v.startsWith('/') || v.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(v)) return false
  // `a..b` is a range of revisions; a path segment that is `..` leaves the directory.
  if (v.split(/[\\/:]/).some((part) => part === '..')) return false
  if (CONTROL.test(v) || /[\t\n*?[\]{}!$`\\"]/.test(v)) return false
  return true
}

const number = (v: string): boolean => /^[0-9]{1,6}$/.test(v)
/** A format string: text and placeholders, but none that makes git call a program (`%G…` runs gpg) and none in the `%(…)` form. */
const format = (v: string): boolean => v.length <= 300 && !/%G|%\(/.test(v) && /^[\w %:|,.()[\]<>{}#*=@'"/+-]*$/.test(v)
const message = (v: string): boolean => v.length <= 20_000
const untracked = (v: string): boolean => /^(no|normal|all)$/.test(v)

const LOG_OPTIONS: Record<string, OptionRule> = {
  '--oneline': true, '--stat': true, '--shortstat': true, '--name-only': true, '--name-status': true, '--graph': true, '--decorate': true, '--all': true, '--no-merges': true, '--merges': true,
  '--first-parent': true, '--reverse': true, '--abbrev-commit': true, '--no-color': true, '--patch': true, '-p': true, '--follow': true, '--no-patch': true, '-s': true,
  '-n': number, '--max-count': number, '--format': format, '--pretty': format, '--author': message, '--grep': message, '--since': message, '--until': message, '--date': (v) => /^[a-z0-9:-]{1,30}$/.test(v),
}
const DIFF_OPTIONS: Record<string, OptionRule> = {
  '--stat': true, '--shortstat': true, '--numstat': true, '--name-only': true, '--name-status': true, '--cached': true, '--staged': true, '--no-color': true, '--summary': true, '--check': true,
  '--word-diff': true, '-w': true, '--ignore-all-space': true, '-b': true, '--ignore-space-change': true, '--patch': true, '-p': true, '--quiet': true, '-q': true, '--exit-code': true,
}

/**
 * Every git subcommand that may run as the user, with every option it may take. Not here on purpose: grep (a
 * pager option runs a program), rebase (it carries out instructions saved in the worktree's own Git directory,
 * and one instruction is `exec`), config, worktree, submodule, everything that reaches a remote, archive,
 * bundle, bisect, difftool, mergetool, filter-branch, gc. And no option that takes up a saved operation again
 * (`--continue`, `--skip`, `--abort`), reads or writes a file somebody names (`-F`, `--output`, `--no-index`),
 * runs a program (`--exec`, `-O`, `--ext-diff`, `--textconv`, `-S` of commit), or looks into a nested
 * repository (`--ignore-submodules`, `--recurse-submodules`).
 */
const SUBCOMMANDS: Record<string, SubcommandRule> = {
  status: { options: { '--short': true, '-s': true, '--porcelain': true, '--branch': true, '-b': true, '--untracked-files': true, '-uall': true, '-uno': true, '-unormal': true, '--long': true, '--ignored': true }, optional: { '--porcelain': (v) => /^(v1|v2|1|2)$/.test(v), '--untracked-files': untracked }, letters: 'sb', operands: 20 },
  log: { options: LOG_OPTIONS, operands: 20 },
  show: { options: { ...LOG_OPTIONS, '--quiet': true, '-q': true }, operands: 20 },
  diff: { options: { ...DIFF_OPTIONS, '-U': number, '--unified': number }, operands: 20 },
  add: { options: { '-A': true, '--all': true, '-u': true, '--update': true, '-f': true, '--force': true, '-v': true, '--verbose': true, '-n': true, '--dry-run': true }, letters: 'Aufvn', operands: 200 },
  commit: {
    options: { '-m': message, '--message': message, '-a': true, '--all': true, '--amend': true, '--no-edit': true, '--allow-empty': true, '--allow-empty-message': true, '-q': true, '--quiet': true, '-v': true, '--verbose': true, '-n': true, '--no-verify': true, '--no-status': true },
    letters: 'aqvn',
    operands: 200,
  },
  'rev-parse': { options: { '--abbrev-ref': true, '--short': true, '--verify': true, '-q': true, '--quiet': true, '--show-toplevel': true, '--is-inside-work-tree': true, '--symbolic-full-name': true, '--show-prefix': true }, operands: 5 },
  branch: { options: { '--show-current': true, '-a': true, '--all': true, '-v': true, '-vv': true, '--list': true, '-l': true, '--no-color': true, '-r': true }, operands: 0 },
  'ls-files': { options: { '-m': true, '--modified': true, '-o': true, '--others': true, '-s': true, '--stage': true, '-d': true, '--deleted': true, '--exclude-standard': true, '-c': true, '--cached': true }, operands: 50 },
  // Files only: `checkout [<revision>] -- <paths>`. Not a change of branch: the worktree stays on the branch NEXUS
  // made for the task, and no other branch of the user's repository is created, moved or checked out here
  // (`checkout -B release` moved a branch of the user's; found by the third review). `switch` is not listed.
  checkout: { options: { '-q': true, '--quiet': true, '-f': true, '--force': true }, operands: 200 },
  restore: { options: { '--staged': true, '-S': true, '--worktree': true, '-W': true, '--source': plainOperand, '-s': plainOperand, '-q': true, '--quiet': true }, operands: 200 },
  reset: { options: { '--hard': true, '--soft': true, '--mixed': true, '-q': true, '--quiet': true }, operands: 200 },
  rm: { options: { '--cached': true, '-r': true, '-f': true, '--force': true, '-q': true, '--quiet': true }, letters: 'rfq', operands: 200 },
  mv: { options: { '-f': true, '--force': true, '-k': true, '-v': true, '--verbose': true }, operands: 2 },
  clean: { options: { '-f': true, '--force': true, '-d': true, '-n': true, '--dry-run': true, '-q': true, '--quiet': true, '-x': true, '-X': true }, letters: 'fdnqxX', operands: 50 },
  stash: {
    options: { '-u': true, '--include-untracked': true, '-m': message, '--message': message, '-q': true, '--quiet': true, '-k': true, '--keep-index': true },
    operands: 2,
    operand: (v, i) => (i === 0 ? /^(push|pop|apply|list|drop|show)$/.test(v) : /^stash@\{[0-9]{1,3}\}$/.test(v) || /^[0-9]{1,3}$/.test(v)),
  },
  merge: { options: { '--no-ff': true, '--ff-only': true, '--ff': true, '--no-edit': true, '--squash': true, '--no-commit': true, '-m': message, '--message': message, '-q': true, '--quiet': true }, operands: 3 },
  'cherry-pick': { options: { '-n': true, '--no-commit': true, '-x': true, '--allow-empty': true }, operands: 20 },
  revert: { options: { '-n': true, '--no-commit': true, '--no-edit': true }, operands: 20 },
  'merge-base': { options: { '--is-ancestor': true, '--all': true }, operands: 3 },
  describe: { options: { '--tags': true, '--always': true, '--abbrev': number, '--all': true }, operands: 1 },
  'rev-list': { options: { '--count': true, '-n': number, '--max-count': number, '--all': true, '--no-merges': true, '--reverse': true }, operands: 5 },
  tag: { options: { '-l': true, '--list': true }, operands: 0 },
}

/** Short options whose value is part of the same word and never the next one. */
const ATTACHED_ONLY = new Set(['-U'])

/** Subcommands for which `.` (the directory the command is in) is an operand. */
const TAKES_DOT = new Set(['add', 'checkout', 'restore', 'reset', 'clean', 'status', 'diff', 'rm'])

/** Whether the words after `git` are a listed subcommand taking only listed options, each spelled in full, and plain operands. */
export function isSafeUserGit(args: readonly string[]): boolean {
  const sub = args[0]
  if (sub === undefined || !Object.hasOwn(SUBCOMMANDS, sub)) return false
  const rule = SUBCOMMANDS[sub] as SubcommandRule
  let operands = 0
  let onlyOperands = false
  let afterSeparator = 0
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] as string
    if (!onlyOperands && arg === '--') {
      onlyOperands = true
      continue
    }
    if (!onlyOperands && arg.startsWith('-') && arg !== '-') {
      const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
      const name = eq > 0 ? arg.slice(0, eq) : arg
      const optionRule = Object.hasOwn(rule.options, name) ? rule.options[name] : undefined
      if (optionRule !== undefined) {
        if (optionRule === true) {
          if (eq > 0 && !(rule.optional !== undefined && Object.hasOwn(rule.optional, name) && (rule.optional[name] as (v: string) => boolean)(arg.slice(eq + 1)))) return false
          continue
        }
        if (name.startsWith('--')) {
          // A long option: the value after `=`, in the same word.
          if (eq <= 0 || !optionRule(arg.slice(eq + 1))) return false
          continue
        }
        if (ATTACHED_ONLY.has(name)) return false
        // A short option: the next word, whatever it looks like, is its value for git too.
        const value = args[i + 1]
        if (value === undefined || !optionRule(value)) return false
        i += 1
        continue
      }
      // `-n3`, `-U5`: a short option and its number in one word.
      const attached = /^(-[A-Za-z])([0-9]{1,6})$/.exec(arg)
      if (attached !== null && Object.hasOwn(rule.options, attached[1] as string) && rule.options[attached[1] as string] === number) continue
      // `-3` for log and show: the number of commits.
      if ((sub === 'log' || sub === 'show') && /^-[0-9]{1,4}$/.test(arg)) continue
      // A cluster of letters, each a listed short option that takes no value: `-fd`, `-sb`.
      if (rule.letters !== undefined && /^-[A-Za-z]{2,6}$/.test(arg) && [...arg.slice(1)].every((letter) => (rule.letters as string).includes(letter))) continue
      // `-am "message"`: all, and the message.
      if (sub === 'commit' && arg === '-am') {
        const value = args[i + 1]
        if (value === undefined || !message(value)) return false
        i += 1
        continue
      }
      return false
    }
    operands += 1
    if (onlyOperands) afterSeparator += 1
    if (operands > rule.operands) return false
    if (arg === '.' && TAKES_DOT.has(sub)) continue
    if (rule.operand !== undefined) {
      if (!rule.operand(arg, operands - 1)) return false
      continue
    }
    if (!plainOperand(arg)) return false
  }
  // A checkout names files after `--`, and at most one revision before it.
  if (sub === 'checkout' && (afterSeparator === 0 || operands - afterSeparator > 1)) return false
  return true
}

/** What git is told on its own command line, after the subcommand, whatever the worktree's files say. */
const FIXED: Record<string, readonly string[]> = {
  // Nothing inside a nested repository is looked at (a `.gitmodules` in the worktree outranks the same setting given as configuration).
  status: ['--ignore-submodules=all'],
  // And no program stands in for the comparison or converts a file for it: `.gitattributes` in the worktree can
  // name any driver the machine's own git configuration defines (measured by the second audit: `diff=astextplain`).
  diff: ['--ignore-submodules=all', '--no-ext-diff', '--no-textconv'],
  log: ['--ignore-submodules=all', '--no-ext-diff', '--no-textconv'],
  show: ['--ignore-submodules=all', '--no-ext-diff', '--no-textconv'],
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * Two functions every script starts with. A nested repository whose entry is in the index is entered by
 * `git add`, `git rm` and `git stash`: they start a second git inside it, under its own configuration, and a
 * filter defined there then runs as the user (measured by the second audit; no setting stops it, a pathspec
 * that leaves the entry out does). `nx_links` lists those entries from the index as pathspecs that exclude
 * them; it is run right before each such command, so an entry made by the command before it is seen.
 */
const SCRIPT_FUNCTIONS = [
  `nx_links() { nx_ex=(); local e; while IFS= read -r -d '' e; do case "$e" in 160000*) nx_ex+=(":(top,exclude,literal)\${e#*$'\\t'}");; esac; done < <(command git ls-files -s -z --full-name -- ':(top)' 2>/dev/null); return 0; }`,
  `nx_nolinks() { nx_links; [ \${#nx_ex[@]} -eq 0 ] && return 0; echo 'NEXUS: the index of this worktree names a nested repository, so git stash is not run here. Commit the work instead.' >&2; return 1; }`,
].join('\n')

/** Whether an `add` names what to add: an operand, or the whole tree by `-A` or `-u`. Bare `git add` adds nothing and scans nothing. */
function addScope(rest: readonly string[]): 'operands' | 'all' | 'none' {
  let all = false
  let after = false
  for (const arg of rest) {
    if (after || !arg.startsWith('-')) return 'operands'
    if (arg === '--') after = true
    else if (arg === '--all' || arg === '--update' || (/^-[A-Za-z]+$/.test(arg) && /[Au]/.test(arg))) all = true
  }
  return all ? 'all' : 'none'
}

/**
 * The invocations of a bash command that is git and nothing else, or null. Every invocation passed
 * `isSafeUserGit`. The caller runs `renderUserGitScript` of the result, never the command.
 */
export function userGitOf(command: string): UserGitInvocation[] | null {
  const parsed = parseUserGit(command)
  if (parsed === null) return null
  for (const invocation of parsed) if (!isSafeUserGit(invocation.args)) return null
  return parsed
}

/**
 * The bash script NEXUS runs for a qualifying command, whichever shell the command was written for: each
 * invocation with every argument quoted by NEXUS, joined as the command joined them. bash is the one shell
 * used because its quoting of an argument is exact; Windows PowerShell 5.1 hands a quoted argument that
 * contains a double quote to a program as something else (measured by the second audit).
 */
export function renderUserGitScript(invocations: readonly UserGitInvocation[]): string {
  const lines = invocations.map((invocation) => {
    const [sub, ...rest] = invocation.args as [string, ...string[]]
    const words = ['git', ...[sub, ...(FIXED[sub] ?? []), ...rest].map(shellQuote)].join(' ')
    let call = words
    if (sub === 'add') {
      const scope = addScope(rest)
      if (scope === 'all') call = `{ nx_links; ${words} ':(top)' "\${nx_ex[@]}"; }`
      else if (scope === 'operands') call = `{ nx_links; ${words} "\${nx_ex[@]}"; }`
    } else if (sub === 'rm') call = `{ nx_links; ${words} "\${nx_ex[@]}"; }`
    // Only `stash list` and `stash drop`, said as the first word, leave the files alone. Anything else is a push,
    // a pop or an apply, whatever comes later on the line (`stash -m list` is a push with the message "list":
    // found by the third review).
    else if (sub === 'stash' && rest[0] !== 'list' && rest[0] !== 'drop') call = `{ nx_nolinks && ${words}; }`
    const stderr = invocation.stderr === 'merge' ? ' 2>&1' : invocation.stderr === 'discard' ? ' 2>/dev/null' : ''
    // An operator at the end of a line continues on the next one; `;` is the end of the line itself.
    const join = invocation.then === '&&' || invocation.then === '||' ? ` ${invocation.then}` : ''
    return `${call}${stderr}${join}`
  })
  return `${SCRIPT_FUNCTIONS}\n${lines.join('\n')}\n`
}

/** True when a bash `command` is one or more listed git invocations and nothing else. */
export function isGitWithFilters(command: string): boolean {
  return userGitOf(command) !== null
}

/**
 * The same question for a command written for PowerShell. The words accepted are those PowerShell 5.1 reads
 * exactly as bash does: printable ASCII only, no quote but the apostrophe, nothing PowerShell would expand, one
 * git per `;`. What then runs is the same bash script as for a bash command: PowerShell is never the one that
 * hands the arguments to git, so the way it re-quotes them (a double quote or a trailing backslash inside an
 * argument changes where the argument ends) cannot matter. A double quote and a backslash are refused all the
 * same, anywhere in the command, so that the text reads the same to whoever compares it with what ran.
 */
export function userGitOfPowerShell(command: string): UserGitInvocation[] | null {
  const parsed = parsePowerShellGit(command)
  if (parsed === null) return null
  for (const invocation of parsed) if (!isSafeUserGit(invocation.args)) return null
  return parsed
}

/** A PowerShell command read into git invocations, or null: the reading alone, before any question of which git. */
function parsePowerShellGit(command: string): UserGitInvocation[] | null {
  if (command.length > 4000 || /[^\x20-\x7e]/.test(command)) return null
  if (/["\\]/.test(command)) return null
  if (/[`$|&<>(){}@#%!*?[\]~]/.test(command.replace(/'[^']*'/g, "''"))) return null
  // A doubled apostrophe is an apostrophe inside a PowerShell string and the end and start of two strings for this parser.
  if (command.includes("''")) return null
  const parsed = parseUserGit(command)
  if (parsed === null) return null
  for (const invocation of parsed) {
    if (invocation.then !== null && invocation.then !== ';') return null
    if (invocation.stderr !== null) return null
    // `--%` stops PowerShell's own reading of the line; an empty word is dropped by it.
    if (invocation.args.some((arg) => arg === '' || arg === '--%')) return null
  }
  return parsed
}

/**
 * A push, for when the user has allowed one. Pushing is outside every profile: it becomes a boundary request,
 * and nothing here runs before the user's grant. Once there is a grant the push must run where it can work:
 * as the user, with the user's network and the user's way of signing in to the remote, which no containment
 * of NEXUS has. So it is the one command that runs outside the containment, and it is held to the same rule as
 * git as the user: the text is parsed, and NEXUS writes what runs.
 *
 * What qualifies: one `git push` and nothing else on the line; options from a short list (none that deletes or
 * overwrites without a check on the remote: `--force` is not among them, `--force-with-lease` is); at most a
 * remote and one refspec, the remote by its NAME as the repository's own configuration knows it (never an
 * address or a path given on the line).
 */
const PUSH_OPTIONS = new Set(['-u', '--set-upstream', '--force-with-lease', '-q', '--quiet', '--porcelain', '-v', '--verbose'])
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** Whether the words after `git` are a push in the form described above. */
export function isGrantablePush(args: readonly string[]): boolean {
  if (args[0] !== 'push') return false
  const operands: string[] = []
  for (const arg of args.slice(1)) {
    if (arg.startsWith('-')) {
      if (!PUSH_OPTIONS.has(arg) || operands.length > 0) return false
      continue
    }
    operands.push(arg)
  }
  if (operands.length > 2) return false
  if (operands[0] !== undefined && !REMOTE_NAME.test(operands[0])) return false
  if (operands[1] !== undefined && (!plainOperand(operands[1]) || operands[1].startsWith('+'))) return false
  return true
}

/**
 * A command that is git and nothing else and pushes: one or more git invocations, joined as git as the user
 * allows, of which at least one is a push in the form above and every other one is on the list of git as the
 * user (`git add -A && git commit -m x && git push origin HEAD`). Null for anything else: a push piped into
 * another program, a push with an option that is not listed, a remote given as an address. Such a command can
 * never run, grant or no grant, so no question is put to the user for it: it is refused with what to write
 * instead.
 */
export function grantedPushOf(command: string, shell: 'bash' | 'powershell' = 'bash'): UserGitInvocation[] | null {
  const parsed = shell === 'bash' ? parseUserGit(command) : parsePowerShellGit(command)
  if (parsed === null) return null
  let pushes = 0
  for (const invocation of parsed) {
    if (invocation.args[0] === 'push') {
      if (!isGrantablePush(invocation.args)) return null
      pushes += 1
    } else if (!isSafeUserGit(invocation.args)) return null
  }
  return pushes > 0 ? parsed : null
}

/** What an agent is told when it tries to push in a form that cannot run. */
export const PUSH_FORM_HINT =
  'A push runs only as a plain git command: `git push <remote> <branch>` with the remote by its name (options: -u, --force-with-lease, -q), alone or joined to other plain git commands with && or ; and with no pipe and no other program on the line. Write it that way; nothing was run and nothing was asked of the user.'

/** The line of the script for an allowed push. `HEAD` is said as the worktree's own branch, so that the entry's `HEAD` file decides nothing. */
export function renderGrantedPush(invocation: UserGitInvocation, branch: string): string {
  const [, ...rest] = invocation.args as [string, ...string[]]
  let operand = 0
  const words = rest.map((arg) => {
    if (arg.startsWith('-')) return arg
    operand += 1
    return operand === 2 && arg === 'HEAD' ? branch : arg
  })
  const stderr = invocation.stderr === 'merge' ? ' 2>&1' : invocation.stderr === 'discard' ? ' 2>/dev/null' : ''
  return `command git ${['push', ...words].map(shellQuote).join(' ')}${stderr}`
}

export function isPlainGitPowerShell(command: string): boolean {
  return userGitOfPowerShell(command) !== null
}
