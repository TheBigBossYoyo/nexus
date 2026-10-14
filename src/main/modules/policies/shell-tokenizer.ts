export type Shell = 'bash' | 'powershell'

export interface Redirect {
  /** e.g. '>', '>>', '>&', '&>', '<' */
  op: string
  target: string
}

export interface Segment {
  /** Words with quotes removed. Redirections are separated out. */
  words: string[]
  redirects: Redirect[]
  /** Separator that preceded this segment ('' for the first). */
  sep: string
  raw: string
}

const MAX_DEPTH = 8

/**
 * Conservative splitter: every unquoted ; && || | & newline ( ) and (PowerShell) { } starts a new
 * sub-command, so command substitutions and script blocks are inspected as commands of their own.
 * Backslashes stay literal because Windows paths use them. `$(...)` inside double quotes is
 * extracted and tokenized recursively.
 */
export function tokenize(input: string, shell: Shell, depth = 0): Segment[] {
  const segments: Segment[] = []
  const extra: Segment[] = []
  let words: string[] = []
  let redirects: Redirect[] = []
  let word = ''
  let started = false
  let pending: string | null = null
  let sep = ''
  let segStart = 0
  const ps = shell === 'powershell'

  const endWord = (): void => {
    if (!started) return
    if (pending !== null) {
      redirects.push({ op: pending, target: word })
      pending = null
    } else words.push(word)
    word = ''
    started = false
  }
  const endSegment = (nextSep: string, at: number): void => {
    endWord()
    if (pending !== null) {
      redirects.push({ op: pending, target: '' })
      pending = null
    }
    if (words.length > 0 || redirects.length > 0) {
      segments.push({ words, redirects, sep, raw: input.slice(segStart, at).trim() })
    }
    words = []
    redirects = []
    sep = nextSep
    segStart = at + nextSep.length
  }
  const addExtra = (inner: string): void => {
    if (depth < MAX_DEPTH) extra.push(...tokenize(inner, shell, depth + 1))
    else extra.push({ words: ['$(<too-deeply-nested>)'], redirects: [], sep: '', raw: inner })
  }

  let i = 0
  while (i < input.length) {
    const c = input.charAt(i)
    const next = input.charAt(i + 1)

    if (c === "'") {
      started = true
      i++
      while (i < input.length) {
        const q = input.charAt(i)
        if (q === "'") {
          if (ps && input.charAt(i + 1) === "'") {
            word += "'"
            i += 2
            continue
          }
          break
        }
        word += q
        i++
      }
      i++
      continue
    }

    if (c === '"') {
      started = true
      i++
      while (i < input.length) {
        const q = input.charAt(i)
        if (q === '"') {
          if (ps && input.charAt(i + 1) === '"') {
            word += '"'
            i += 2
            continue
          }
          break
        }
        if (ps && q === '`' && i + 1 < input.length) {
          word += input.charAt(i + 1)
          i += 2
          continue
        }
        if (!ps && q === '\\' && input.charAt(i + 1) === '"') {
          word += '"'
          i += 2
          continue
        }
        if (q === '$' && input.charAt(i + 1) === '(') {
          const { inner, end } = matchParen(input, i + 2)
          addExtra(inner)
          word += input.slice(i, end)
          i = end
          continue
        }
        if (!ps && q === '`') {
          const close = input.indexOf('`', i + 1)
          const end = close === -1 ? input.length : close + 1
          addExtra(input.slice(i + 1, close === -1 ? input.length : close))
          word += input.slice(i, end)
          i = end
          continue
        }
        word += q
        i++
      }
      i++
      continue
    }

    if (ps && c === '`') {
      if (next === '\n' || next === '\r') {
        endWord()
        i += next === '\r' && input.charAt(i + 2) === '\n' ? 3 : 2
        continue
      }
      started = true
      word += next
      i += 2
      continue
    }

    if (!ps && c === '\\') {
      if (next === '\n') {
        i += 2
        continue
      }
      if (next === "'" || next === '"' || next === ' ' || next === '$' || next === '`' || next === ';' || next === '&' || next === '|' || next === '>' || next === '<' || next === '(' || next === ')') {
        started = true
        word += next
        i += 2
        continue
      }
      started = true
      word += c
      i++
      continue
    }

    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }
    if (c === '\n' || c === '\r') {
      endSegment('\n', i)
      i++
      continue
    }
    if (c === '#' && !started) {
      while (i < input.length && input.charAt(i) !== '\n') i++
      continue
    }
    if (c === ';') {
      endSegment(';', i)
      i++
      continue
    }
    if (c === '&') {
      if (next === '&') {
        endSegment('&&', i)
        i += 2
      } else if (next === '>' && !ps) {
        endWord()
        const op = input.charAt(i + 2) === '>' ? '&>>' : '&>'
        pending = op
        i += op.length
      } else if (ps && words.length === 0 && !started) {
        started = true
        word = '&'
        endWord()
        i++
      } else {
        endSegment('&', i)
        i++
      }
      continue
    }
    if (c === '|') {
      if (next === '|') {
        endSegment('||', i)
        i += 2
      } else {
        endSegment('|', i)
        i += next === '&' ? 2 : 1
      }
      continue
    }
    if (c === '`' && !ps) {
      if (words.length === 0 && !started && pending === null) {
        extra.push({ words: ['$(<substitution>)'], redirects: [], sep: '', raw: '`' })
      }
      endSegment('`', i)
      i++
      continue
    }
    if (c === '(' || c === ')') {
      endSegment(c, i)
      i++
      continue
    }
    if (c === '{' || c === '}') {
      const reserved = ps || (!started && (next === '' || /\s/.test(next) || c === '}'))
      if (reserved) {
        endSegment(c, i)
        i++
        continue
      }
    }
    if (c === '$' && next === '(' && !ps && words.length === 0 && !started && pending === null && input.charAt(i + 2) !== '(') {
      // A command substitution in command position: the command's name is computed at run time.
      extra.push({ words: ['$(<substitution>)'], redirects: [], sep: '', raw: '$(' })
    }
    if ((c === '$' || c === '@') && (next === '(' || (next === '{' && c === '@' && ps))) {
      // `$(` and `@(` are handled by the following paren; keep the sigil out of the word.
      i++
      continue
    }
    if (c === '$' && next === '{') {
      const close = input.indexOf('}', i)
      const end = close === -1 ? input.length : close + 1
      started = true
      word += input.slice(i, end)
      i = end
      continue
    }
    if (c === '>' || c === '<') {
      if (started && /^\d+$/.test(word) && pending === null) {
        word = ''
        started = false
      } else endWord()
      let op = c
      i++
      while (input.charAt(i) === c && op.length < 3) {
        op += c
        i++
      }
      if (c === '>' && (input.charAt(i) === '&' || input.charAt(i) === '|')) {
        op += input.charAt(i)
        i++
      }
      pending = op
      continue
    }

    started = true
    word += c
    i++
  }
  endSegment('', input.length)
  return [...segments, ...extra]
}

function matchParen(input: string, start: number): { inner: string; end: number } {
  let depth = 1
  let i = start
  while (i < input.length) {
    const c = input.charAt(i)
    if (c === "'" || c === '"') {
      const close = input.indexOf(c, i + 1)
      i = close === -1 ? input.length : close + 1
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return { inner: input.slice(start, i), end: i + 1 }
    }
    i++
  }
  return { inner: input.slice(start), end: input.length }
}

// ---------------------------------------------------------------------------------------------
// Inert heredoc text (git commit messages)
// ---------------------------------------------------------------------------------------------

const GIT_PREFIX = String.raw`(?:^|[\n;&|])[ \t]*git(?:[ \t]+-C[ \t]+(?:"[^"\n$\`]*"|'[^'\n]*'|[^\s"'$\`;&|()<>]+))*[ \t]+commit`
/** `git commit [simple flags] -m "` immediately before a substitution. Flags may not take values. */
const COMMIT_MESSAGE_PREFIX = new RegExp(
  `${GIT_PREFIX}(?:[ \t]+--?[A-Za-z][A-Za-z-]*)*[ \t]+(?:-[A-Za-z]*m|--message)(?:[ \t]+|=)"$`,
)
/** `git commit [simple flags] -F -` immediately before a quoted heredoc. */
const COMMIT_STDIN_PREFIX = new RegExp(`${GIT_PREFIX}(?:[ \t]+--?[A-Za-z][A-Za-z-]*)*[ \t]+(?:-F|--file)(?:[ \t]+|=)-[ \t]+$`)
const MESSAGE_OPENER = /\$\([ \t]*cat[ \t]+<<(-?)[ \t]*'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\r?\n/g
const STDIN_OPENER = /<<(-?)[ \t]*'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\r?\n/g

/** True when `s` ends outside every single-quoted, double-quoted or backtick region (bash rules). */
function quotesBalanced(s: string): boolean {
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (quote === "'") {
      if (c === "'") quote = ''
    } else if (c === '\\') i++
    else if (quote !== '') {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'" || c === '`') quote = c
  }
  return quote === ''
}

/** Index just past the heredoc terminator line (including its newline), or -1 when it never terminates. */
function heredocEnd(text: string, from: number, delim: string, stripTabs: boolean): number {
  let pos = from
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos)
    const raw = text.slice(pos, nl < 0 ? text.length : nl).replace(/\r$/, '')
    if ((stripTabs ? raw.replace(/^\t+/, '') : raw) === delim) return nl < 0 ? text.length : nl + 1
    if (nl < 0) return -1
    pos = nl + 1
  }
  return -1
}

/**
 * Replaces the text of a quoted heredoc used purely as a git commit message with an inert placeholder,
 * so prose such as "Co-Authored-By: X <a@b.c>" or "rm -rf" is not parsed as shell. Only two shapes
 * qualify, and only for `git commit`:
 *   git commit [flags] -m "$(cat <<'EOF' ... EOF )"   (substitution holds nothing but that heredoc)
 *   git commit [flags] -F - <<'EOF' ... EOF
 * The delimiter must be quoted (no expansion in the body), the opener line must hold nothing else, the
 * terminator must be a line of its own, and the substitution must close immediately after it. Anything
 * else is returned untouched and analysed as ordinary shell.
 */
export function neutralizeCommitHeredocs(text: string): string {
  if (!text.includes('<<')) return text
  let out = text
  for (const [opener, prefixRe, mode] of [
    [MESSAGE_OPENER, COMMIT_MESSAGE_PREFIX, 'message'],
    [STDIN_OPENER, COMMIT_STDIN_PREFIX, 'stdin'],
  ] as const) {
    let from = 0
    for (let guard = 0; guard < 16; guard++) {
      opener.lastIndex = from
      const m = opener.exec(out)
      if (m === null) break
      from = m.index + 1
      const before = out.slice(0, m.index)
      const prefix = prefixRe.exec(before)
      if (prefix === null || !quotesBalanced(out.slice(0, prefix.index))) continue
      const end = heredocEnd(out, m.index + m[0].length, m[2] ?? '', m[1] === '-')
      if (end < 0) continue
      if (mode === 'message') {
        const close = /^[ \t\r\n]*\)"/.exec(out.slice(end))
        if (close === null) continue
        out = `${before}MESSAGE${out.slice(end + close[0].length - 1)}`
      } else {
        out = `${before.replace(/[ \t]+$/, '')}${out.slice(end - (out.charAt(end - 1) === '\n' ? 1 : 0))}`
      }
      from = 0
    }
  }
  return out
}

// A redirection target: simple unquoted word, or a quoted string without expansion.
const TARGET = String.raw`(?:"[^"\n$\`]*"|'[^'\n]*'|[^\s"'$\`;&|<>()-][^\s"'$\`;&|<>()]*)`
const REDIRECT = String.raw`(?:\d?>>?[ \t]*${TARGET}|\d?>&\d)`
/** Start of a command (line start or after ; & |, never "(" or a backtick), then `cat` with only output redirections. */
const CAT_PREFIX = new RegExp(String.raw`(?:^|[\n;&|])[ \t]*cat(?:[ \t]+${REDIRECT})*[ \t]*$`)
/** `tee [-a] file...` */
const TEE_PREFIX = new RegExp(String.raw`(?:^|[\n;&|])[ \t]*tee(?:[ \t]+-a)?(?:[ \t]+${TARGET})+[ \t]*$`)
/** What may follow the opener on its line: more output redirections, then end of line, a comment, && || or ; (never a lone pipe). */
const OPENER_REST = new RegExp(String.raw`^(?:[ \t]*${REDIRECT})*[ \t]*(?:$|#|&&|\|\||;)`)
const ANY_OPENER = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g

/**
 * Removes heredocs that are plain data from the text that gets analysed as shell: the delimiter is quoted
 * ('EOF' or "EOF", so nothing in the body expands), the only consumer on the command is `cat` (optionally
 * redirected to files) or `tee <files>`, the opener line carries nothing but further redirections or a
 * following && / || / ; command, and the terminator is a line of its own. Redirection targets stay in the
 * text, so the usual path checks still apply to them. Everything else is left exactly as written:
 * interpreters and any other consumer, unquoted delimiters, `cat <<'EOF' | sh`, several heredocs opened on
 * one line. Bodies of heredocs that are not removed are skipped, so text inside them is never mistaken for
 * a command line. Text after the terminator is analysed normally.
 */
export function neutralizeInertHeredocs(text: string): string {
  if (!text.includes('<<')) return text
  let out = text
  let scanFrom = 0
  for (let guard = 0; guard < 64; guard++) {
    ANY_OPENER.lastIndex = scanFrom
    const m = ANY_OPENER.exec(out)
    if (m === null) break
    const before = out.slice(0, m.index)
    if (!quotesBalanced(before)) break
    const openerEnd = m.index + m[0].length
    const nl = out.indexOf('\n', openerEnd)
    if (nl < 0) break
    const restLine = out.slice(openerEnd, nl).replace(/\r$/, '')
    if (/<<(?!<)/.test(restLine.replace(/(['"]).*?\1/g, ''))) break // several heredocs on one line: give up
    const quoted = m[2] !== undefined || m[3] !== undefined
    const delim = m[2] ?? m[3] ?? m[4] ?? ''
    const end = delim === '' ? -1 : heredocEnd(out, nl + 1, delim, m[1] === '-')
    if (end < 0) break
    const inert = quoted && (CAT_PREFIX.test(before) || TEE_PREFIX.test(before)) && OPENER_REST.test(restLine)
    if (inert) {
      out = `${before.replace(/[ \t]+$/, '')}${restLine}\n${out.slice(end)}`
      scanFrom = 0 // earlier text is unchanged, but positions after it moved; rescan is cheap
      continue
    }
    scanFrom = end // skip the body of a heredoc we cannot vouch for
  }
  return out
}

/** Start of a command, then an interpreter that is not a shell, with plain arguments (`python3 -`, `node`, `py -X utf8 -`). */
const PROGRAM_PREFIX = new RegExp(String.raw`(?:^|[\n;&|])[ \t]*(?:[\w.:~-]*[\\/])?(?:python3?|py|node|perl|ruby|php|lua|bun)(?:\.exe)?(?:[ \t]+[\w./=:+-]+)*[ \t]*$`, 'i')

/**
 * 0.9.1: a quoted heredoc read by an interpreter that is not a shell (`python3 - <<'E'`) is a program in that
 * language, or data for it: never shell. Its body is taken out of the text analysed as shell and returned on
 * its own, so the classifier can judge it as it judges `python3 -c "<program>"`. As shell, a line such as
 * `a: 1` read as the drive A:, and `Map<string | null>` as a redirection and a pipe, and an agent editing a file
 * with a short script had to wait for the owner's approval. Only quoted delimiters (an unquoted body expands
 * `$(...)` in the shell) and only these interpreters: a heredoc read by sh, bash, PowerShell or cmd stays shell.
 */
export function separateProgramHeredocs(text: string): { text: string; programs: string[] } {
  if (!text.includes('<<')) return { text, programs: [] }
  let out = text
  const programs: string[] = []
  let scanFrom = 0
  for (let guard = 0; guard < 64; guard++) {
    ANY_OPENER.lastIndex = scanFrom
    const m = ANY_OPENER.exec(out)
    if (m === null) break
    const before = out.slice(0, m.index)
    if (!quotesBalanced(before)) break
    const openerEnd = m.index + m[0].length
    const nl = out.indexOf('\n', openerEnd)
    if (nl < 0) break
    const restLine = out.slice(openerEnd, nl).replace(/\r$/, '')
    if (/<<(?!<)/.test(restLine.replace(/(['"]).*?\1/g, ''))) break // several heredocs on one line: give up
    const quoted = m[2] !== undefined || m[3] !== undefined
    const delim = m[2] ?? m[3] ?? m[4] ?? ''
    const end = delim === '' ? -1 : heredocEnd(out, nl + 1, delim, m[1] === '-')
    if (end < 0) break
    if (quoted && PROGRAM_PREFIX.test(before) && OPENER_REST.test(restLine)) {
      programs.push(out.slice(nl + 1, end))
      out = `${before.replace(/[ \t]+$/, '')}${restLine}\n${out.slice(end)}`
      scanFrom = 0
      continue
    }
    scanFrom = end
  }
  return { text: out, programs }
}
