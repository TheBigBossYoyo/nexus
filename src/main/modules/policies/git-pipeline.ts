import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * 0.8: whether a bash command is git together with nothing but text filters and listings: `git log | head -3`,
 * `git status --short; git diff --stat | tail -5`, `cd src && git ls-files | grep test | wc -l`.
 *
 * It matters under the ISOLATED profile. There a command runs as the sandbox account, which cannot read the
 * user's repository, so git inside it finds no repository. A command that is git alone has always been run
 * where the repository is readable (as the user, at low integrity, with git hardened). This widens "git alone"
 * to the commands agents actually write, without widening what can run there: every program in the command is
 * git or one of a few tools that only read their input and the files they are named, every file named is
 * inside the worktree, and the shell is given nothing to expand.
 *
 * The answer is "no" for anything not understood. "No" is not a refusal: the command then runs under the
 * session's own profile, as before.
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

/**
 * True when `command` is made of git and read-only filters only, with at least one git, and may therefore
 * run where git can read the repository. `worktree` is the session's worktree and `cwd` where the shell is.
 */
export function isGitWithFilters(command: string, worktree: string, cwd: string): boolean {
  if (command.length > 4000 || /[\r\n]/.test(command)) return false
  const stripped = command.replace(HARMLESS_REDIRECT, '$1')
  // Nothing for the shell to expand, substitute, redirect or group: no variable, no glob, no home, no subshell.
  if (/[$`<>(){}*?[\]~!#]/.test(stripped.replace(/'[^']*'/g, "''"))) return false
  // Inside single quotes anything is literal except what the tools themselves would read as a file; a `$` there is a regex anchor.
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
      git += 1
      // git's own arguments were judged by the command classifier; here only `-C` and its kin, which would move
      // git out of the worktree, are looked at.
      for (let i = 1; i < words.length; i += 1) {
        const arg = words[i] as string
        if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree' || arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=') || arg === '--exec-path' || arg.startsWith('--exec-path=') || arg === '-c') return false
        if (!arg.startsWith('-')) break
      }
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
