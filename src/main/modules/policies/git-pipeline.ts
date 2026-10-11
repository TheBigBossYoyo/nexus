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
        // Only as the message: the word right after `-m` or `--message`.
        const before = words[words.length - 1]
        if (before !== '-m' && before !== '--message') return null
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

/** How an option is taken: alone, or with a value that must pass a test (given as `--opt=value` or as the next word). */
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
  if (CONTROL.test(v) || /[\t\n*?[\]{}!$`\\]/.test(v)) return false
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
  checkout: { options: { '-b': plainOperand, '-B': plainOperand, '-q': true, '--quiet': true, '-f': true, '--force': true }, operands: 200 },
  switch: { options: { '-c': plainOperand, '--create': plainOperand, '-q': true, '--quiet': true }, operands: 1 },
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

/** Subcommands for which `.` (the directory the command is in) is an operand. */
const TAKES_DOT = new Set(['add', 'checkout', 'restore', 'reset', 'clean', 'status', 'diff', 'rm'])

/** Whether the words after `git` are a listed subcommand taking only listed options, each spelled in full, and plain operands. */
export function isSafeUserGit(args: readonly string[]): boolean {
  const sub = args[0]
  if (sub === undefined || !Object.hasOwn(SUBCOMMANDS, sub)) return false
  const rule = SUBCOMMANDS[sub] as SubcommandRule
  let operands = 0
  let onlyOperands = false
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
        // The value: after `=`, or the next word.
        const value = eq > 0 ? arg.slice(eq + 1) : args[i + 1]
        if (value === undefined || !optionRule(value)) return false
        if (eq <= 0) i += 1
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
    if (operands > rule.operands) return false
    if (arg === '.' && TAKES_DOT.has(sub)) continue
    if (rule.operand !== undefined) {
      if (!rule.operand(arg, operands - 1)) return false
      continue
    }
    if (!plainOperand(arg)) return false
  }
  return true
}

/** Subcommands that compare against the worktree or print differences: they are told on their own command line to stay out of nested repositories. */
const LOOKS_AT_WORKTREE = new Set(['status', 'diff', 'log', 'show'])

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

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
 * The bash script NEXUS runs for a qualifying command: each invocation with every argument quoted by NEXUS,
 * joined as the command joined them. A setting the worktree's own `.gitmodules` can switch back on is given
 * on the command line, where it cannot (measured: `submodule.<name>.ignore = none` in `.gitmodules` outranks
 * `diff.ignoreSubmodules=all` from the environment, and a status then runs a nested repository's filter).
 */
export function renderUserGitScript(invocations: readonly UserGitInvocation[]): string {
  const lines = invocations.map((invocation) => {
    const [sub, ...rest] = invocation.args as [string, ...string[]]
    const extra = LOOKS_AT_WORKTREE.has(sub) ? ['--ignore-submodules=all'] : []
    const words = ['git', ...[sub, ...extra, ...rest].map(shellQuote)]
    const stderr = invocation.stderr === 'merge' ? ' 2>&1' : invocation.stderr === 'discard' ? ' 2>/dev/null' : ''
    // An operator at the end of a line continues on the next one; `;` is the end of the line itself.
    const join = invocation.then === '&&' || invocation.then === '||' ? ` ${invocation.then}` : ''
    return `${words.join(' ')}${stderr}${join}`
  })
  return `${lines.join('\n')}\n`
}

/** True when a bash `command` is one or more listed git invocations and nothing else. */
export function isGitWithFilters(command: string): boolean {
  return userGitOf(command) !== null
}

/**
 * The same question for PowerShell. The words accepted are those PowerShell 5.1 reads exactly as bash does:
 * printable ASCII only, no quote but the apostrophe, nothing PowerShell would expand, one git per `;`.
 */
export function userGitOfPowerShell(command: string): UserGitInvocation[] | null {
  if (command.length > 4000 || /[^\x20-\x7e]/.test(command)) return null
  if (/["`$|&<>(){}@#%!*?[\]~\\]/.test(command.replace(/'[^']*'/g, "''"))) return null
  // A doubled apostrophe is an apostrophe inside a PowerShell string and the end and start of two strings for this parser.
  if (command.includes("''")) return null
  const parsed = parseUserGit(command)
  if (parsed === null) return null
  for (const invocation of parsed) {
    if (invocation.then !== null && invocation.then !== ';') return null
    if (invocation.stderr !== null) return null
    if (!isSafeUserGit(invocation.args)) return null
  }
  return parsed
}

export function isPlainGitPowerShell(command: string): boolean {
  return userGitOfPowerShell(command) !== null
}

const powershellQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** The PowerShell script NEXUS runs for a qualifying PowerShell command: `git.exe` by name, every argument quoted by NEXUS. */
export function renderUserGitPowerShell(invocations: readonly UserGitInvocation[]): string {
  return `${invocations
    .map((invocation) => {
      const [sub, ...rest] = invocation.args as [string, ...string[]]
      const extra = LOOKS_AT_WORKTREE.has(sub) ? ['--ignore-submodules=all'] : []
      return `& git.exe ${[sub, ...extra, ...rest].map(powershellQuote).join(' ')}`
    })
    .join('\n')}\n`
}
