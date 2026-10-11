import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * 0.8: which shell commands may run where git can change a ref of the user's repository: as the user, at low
 * integrity, instead of as the sandbox account. That place has the user's network and reads what the user's
 * low-integrity processes read, so what runs there must be git doing a known thing, and nothing else.
 *
 * A command qualifies when all of this holds, and only then:
 *  - every program in it is git, or (bash only) one of a few tools that read their input and the files they
 *    are named and write only to standard output;
 *  - every git names, as its first word, a subcommand from a fixed list; nothing stands between `git` and the
 *    subcommand (no `-c`, `-C`, `--git-dir`, `--exec-path`, no pager switch);
 *  - no git argument is one that makes git run a program, read or write a file somebody names, or look at
 *    another repository (`-O`, `--open-files-in-pager`, `--exec`, `--output`, `--ext-diff`, `--textconv`,
 *    `--no-index`, `-F`, `--template` and their kin);
 *  - every file a filter is named is inside the worktree, links resolved;
 *  - the shell is given nothing to expand, substitute, redirect or group. The one substitution accepted is
 *    the commit message written as a quoted here-document, `-m "$(cat <<'EOF' … EOF)"`, whose text the shell
 *    takes literally.
 *
 * The answer is "no" for anything not understood. "No" is not a refusal: the command then runs under the
 * session's own profile, where a ref-changing git is told to be run as a command of its own.
 *
 * This list is the whole of what an agent's text can make run as the user. Review of 2026-10-11 (independent):
 * before it, the verdict "git alone" came from the command classifier, which let through `git grep -Ocmd`,
 * `git --exec-path=.`, `git --git-dir=<dir with an alias>` and others. What git is pointed at and what it reads
 * as configuration is pinned separately, in the environment the execution broker gives it.
 */

/** Tools that read standard input or the files named to them and write only to standard output. */
const FILTERS = new Set(['head', 'tail', 'grep', 'wc', 'sort', 'uniq', 'cut', 'tr', 'cat', 'ls', 'nl', 'echo', 'pwd', 'true', 'cd'])
/** Filters whose first plain argument is a pattern or a set, not a file. */
const FIRST_ARG_IS_NOT_A_FILE = new Set(['grep', 'tr'])
/** Arguments that are never files. */
const NO_FILE_ARGS = new Set(['echo', 'tr', 'pwd', 'true'])
/** Options that make a filter write a file, read a list of files from one, or run a program. */
const REFUSED_LONG = /^--(output|file|files0-from|compress-program|temporary-directory|include-from|exclude-from)\b/
/** Redirections that send output nowhere or merge the two streams: taken out before anything else is read. */
const HARMLESS_REDIRECT = /(^|\s)(2>&1|2>\s?\/dev\/null|>\s?\/dev\/null|&>\s?\/dev\/null)(?=\s|$|[;|&])/g

/**
 * The git subcommands that may run as the user. Each works on the worktree, its index and its own branch;
 * none takes a program to run once the options below are refused. Not here on purpose: grep (a pager option
 * runs a program), config, worktree, submodule, clone, fetch, pull, push, remote, archive, bundle, bisect,
 * difftool, mergetool, filter-branch, gc, init, daemon, and everything unknown.
 */
const GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'add', 'commit', 'ls-files', 'rev-parse', 'blame', 'branch', 'restore', 'reset', 'checkout', 'switch', 'rm', 'mv',
  'merge-base', 'describe', 'shortlog', 'cat-file', 'ls-tree', 'rev-list', 'for-each-ref', 'reflog', 'cherry-pick', 'revert', 'merge', 'rebase', 'stash', 'clean', 'tag',
])
/** Long options refused in any git command: they run a program, name a file to read or write, or point git elsewhere. */
const GIT_REFUSED_LONG = /^--(exec|exec-path|output|output-directory|open-files-in-pager|ext-diff|textconv|template|upload-pack|receive-pack|git-dir|work-tree|no-index|file|pathspec-from-file|patterns-from-file|config|config-env|attr-source|super-prefix|namespace|separate-git-dir|gpg-sign|show-signature|paginate|edit|interactive|patch-with-raw|strategy|strategy-option|contents|ignore-revs-file|reference|filter|to-stdin|stdin|batch|batch-check|batch-command|rebase-merges|autosquash|reschedule-failed-exec)(=|$)/
/** Short option letters refused per subcommand: `-x` of rebase runs a command, `-F` reads a file, `-S` runs the signing program, `-i`/`-p`/`-e` open an editor or a prompt. */
const GIT_REFUSED_SHORT: Record<string, RegExp> = {
  rebase: /[xiSs]/,
  commit: /[FSepi]/,
  merge: /[FSes]/,
  tag: /[FSsue]/,
  'cherry-pick': /[Se]/,
  revert: /[Se]/,
  add: /[epi]/,
  checkout: /[p]/,
  restore: /[p]/,
  reset: /[p]/,
  stash: /[p]/,
  clean: /[i]/,
  blame: /[S]/,
}

function insideOf(root: string, path: string): boolean {
  const r = resolve(root).toLowerCase()
  const p = resolve(path).toLowerCase()
  return p === r || p.startsWith(`${r}\\`)
}

/** Splits into segments at `&&`, `||`, `;` and `|`, and each segment into words, honouring quotes. Null when it cannot. */
function parse(command: string): string[][] | null {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let has = false
  let quote: '"' | "'" | null = null
  const endWord = (): void => {
    if (has) words.push(word)
    word = ''
    has = false
  }
  const endSegment = (): boolean => {
    endWord()
    if (words.length === 0) return false
    segments.push(words)
    words = []
    return true
  }
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
      // Inside double quotes a backslash still escapes; none is accepted there.
      else if (quote === '"' && ch === '\\') return null
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === ' ' || ch === '\t') endWord()
    else if (ch === ';' || ch === '|' || ch === '&') {
      if (ch === '&' && command[i + 1] !== '&') return null
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i += 1
      if (!endSegment()) return null
    } else if (ch === '\\') return null
    else {
      word += ch
      has = true
    }
  }
  if (quote !== null) return null
  endWord()
  if (words.length > 0) segments.push(words)
  return segments
}

/** Whether the words after `git` are a listed subcommand with no argument that runs a program, names a file to read or write, or points git elsewhere. */
export function isSafeUserGit(args: readonly string[]): boolean {
  const sub = args[0]
  if (sub === undefined || !GIT_SUBCOMMANDS.has(sub)) return false
  const refusedShort = GIT_REFUSED_SHORT[sub]
  let options = true
  for (const arg of args.slice(1)) {
    if (!options) continue
    if (arg === '--') {
      options = false
      continue
    }
    if (arg.startsWith('--')) {
      if (GIT_REFUSED_LONG.test(arg)) return false
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      // `-O` (a pager, or an order file) and `-c`/`-C` where they would be read as configuration or as another directory.
      if (/^-O/.test(arg)) return false
      const letters = arg.slice(1).replace(/[0-9=].*$/, '')
      if (refusedShort !== undefined && refusedShort.test(letters)) return false
    }
  }
  // Listing only: creating, moving or deleting a tag or a branch that is not the task's own is not this path's work.
  if (sub === 'tag' && args.slice(1).some((a) => !a.startsWith('-'))) return false
  return true
}

const HEREDOC_MESSAGE = /"\$\(cat <<'([A-Za-z_][A-Za-z0-9_]*)'\n[\s\S]*?\n\1\n[ \t]*\)"/g

/**
 * True when a bash `command` is made of listed git subcommands and read-only filters only, with at least one
 * git, and may therefore run where git can change a ref. `worktree` is the session's worktree and `cwd` where
 * the shell is.
 */
export function isGitWithFilters(command: string, worktree: string, cwd: string): boolean {
  if (command.length > 8000) return false
  // A commit message as a quoted here-document is literal text for the shell: it counts as one word.
  const flat = command.replace(HEREDOC_MESSAGE, "'message'")
  if (/[\r\n]/.test(flat)) return false
  const stripped = flat.replace(HARMLESS_REDIRECT, '$1')
  // Nothing for the shell to expand, substitute, redirect or group: no variable, no glob, no home, no subshell.
  const bare = stripped.replace(/'[^']*'/g, "''")
  if (/[$`<>(){}*?[\]!#]/.test(bare)) return false
  // `~` is the home directory only where a word begins; `HEAD~1` is a commit.
  if (/(^|[\s=:])~/.test(bare)) return false
  if (/[`]/.test(stripped)) return false
  const segments = parse(stripped)
  if (segments === null || segments.length === 0 || segments.length > 12) return false
  let here = insideOf(worktree, cwd) ? resolve(cwd) : resolve(worktree)
  let git = 0
  const fileInside = (arg: string): boolean => {
    if (arg === '-') return true
    if (/^[A-Za-z]:/.test(arg) || arg.startsWith('/') || arg.startsWith('\\')) {
      // An absolute path in the form bash takes (`/c/x`) is not followed here: only what resolves plainly.
      if (!isAbsolute(arg) || arg.startsWith('/') || arg.startsWith('\\')) return false
    }
    const target = resolve(here, arg)
    if (!insideOf(worktree, target)) return false
    // A link or a junction inside the worktree that leads out of it is a file outside it.
    try {
      if (existsSync(target) && !insideOf(realpathSync(worktree), realpathSync(target))) return false
    } catch {
      return false
    }
    return true
  }
  for (const words of segments) {
    const program = words[0] as string
    if (program === 'git') {
      if (!isSafeUserGit(words.slice(1))) return false
      git += 1
      continue
    }
    if (!FILTERS.has(program)) return false
    let plain = 0
    for (const arg of words.slice(1)) {
      if (arg.startsWith('--')) {
        if (arg !== '--' && (REFUSED_LONG.test(arg) || !/^--[a-z][a-z0-9-]*(=[\w.,:+-]*)?$/.test(arg))) return false
        continue
      }
      if (arg.startsWith('-') && arg !== '-') {
        if (!/^-[A-Za-z0-9]+$/.test(arg)) return false
        // `sort -o` writes a file and `-T` names a directory; `grep -f` reads patterns from a file; `tail -f` never ends.
        if (program === 'sort' && /[oT]/.test(arg)) return false
        if (program === 'grep' && /f/.test(arg)) return false
        if (program === 'tail' && /[fF]/.test(arg)) return false
        continue
      }
      plain += 1
      if (NO_FILE_ARGS.has(program)) continue
      if (FIRST_ARG_IS_NOT_A_FILE.has(program) && plain === 1) continue
      // `uniq in out` writes its second argument.
      if (program === 'uniq' && plain > 1) return false
      if (program === 'cd') {
        if (plain > 1 || !fileInside(arg)) return false
        here = resolve(here, arg)
        continue
      }
      if (!fileInside(arg)) return false
    }
    if (program === 'cd' && plain === 0) return false
  }
  return git > 0
}

/**
 * The same question for PowerShell, where the tools around git are cmdlets of another kind: only git itself,
 * one command or several separated by `;`, in words PowerShell takes as they are written.
 */
export function isPlainGitPowerShell(command: string): boolean {
  if (command.length > 4000 || /[\r\n]/.test(command)) return false
  // Nothing PowerShell would expand or run: no variable, subexpression, backtick, pipe, call operator, redirect, brace or splat.
  if (/[$`|&<>(){}@#%!*?[\]~\\]/.test(command.replace(/'[^']*'/g, "''")) || command.includes('"')) return false
  const segments = command.split(';').map((s) => s.trim()).filter((s) => s !== '')
  if (segments.length === 0 || segments.length > 8) return false
  for (const segment of segments) {
    const words = parse(segment)
    if (words === null || words.length !== 1) return false
    const [program, ...args] = words[0] as string[]
    if (program !== 'git' || !isSafeUserGit(args)) return false
  }
  return true
}
