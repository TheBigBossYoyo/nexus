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
