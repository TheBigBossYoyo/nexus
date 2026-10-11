/**
 * 0.8: from a fetched page to the text a reader sees. Scripts, styles, templates and comments are not text;
 * an element hidden by its own markup is not text a reader sees either, and what it held is counted and left
 * out, because hidden text is where instructions for a model are put. This is a tokenizer, not a browser: CSS
 * in a stylesheet that hides an element is not seen (the research browser, which renders, reads the
 * accessibility tree instead). What comes out is data; nothing here decides what the data may do.
 */

export interface ExtractedPage {
  title: string | null
  /** Visible text, block elements as lines, at most `maxChars`. */
  text: string
  truncated: boolean
  /** Absolute http(s) links in document order, without duplicates, at most 200. */
  links: { url: string; text: string }[]
  /** Characters of text that sat in elements hidden by their own attributes or inline style. */
  hiddenChars: number
  /** Characters inside HTML comments. */
  commentChars: number
}

const SKIPPED = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'iframe', 'object', 'embed', 'select', 'textarea', 'canvas', 'audio', 'video'])
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'tr', 'table', 'thead', 'tbody', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'br', 'hr', 'figure', 'figcaption', 'details', 'summary', 'form', 'address'])
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'source', 'track', 'wbr'])

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', trade: '™', middot: '·', bull: '•', deg: '°', times: '×' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' '
      return String.fromCodePoint(code)
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

function attributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const name = (m[1] as string).toLowerCase()
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

/** Whether an element's own attributes hide it from a reader. */
function hiddenByMarkup(attrs: Record<string, string>): boolean {
  if ('hidden' in attrs) return true
  if (attrs['aria-hidden'] === 'true') return true
  if (attrs['type'] === 'hidden') return true
  const style = (attrs['style'] ?? '').toLowerCase().replace(/\s+/g, '')
  if (style === '') return false
  if (/display:none|visibility:hidden|visibility:collapse|opacity:0(?![.\d]*[1-9])|font-size:0(?:px|em|rem|pt|%)?(?:;|$)|(?:^|;)(?:width|height|max-height|max-width):0(?:px)?(?:;|$)/.test(style)) return true
  if (/(?:left|top|text-indent|margin-left):-\d{4,}/.test(style)) return true
  if (/clip:rect\(0(?:px)?,?0(?:px)?,?0(?:px)?,?0(?:px)?\)|clip-path:inset\(100%\)/.test(style)) return true
  return false
}

const collapse = (text: string): string => text.replace(/[ \t\f\v\u00a0]+/g, ' ')

/** The most of a document that is read: more than this is not a page, and the rest is left unread. */
export const MAX_HTML_INPUT = 1024 * 1024
/** Tags read in one document; a document with more is read up to there. */
const MAX_TAGS = 250_000
/** Open elements that hide their content, nested; deeper than this is not a page. */
const MAX_DEPTH = 512
const MAX_TAG_LENGTH = 20_000
/** Characters looked at for a tag that turned out not to be one, over the whole document: what keeps a document made of broken tags linear. */
const MAX_FAILED_SCAN = 4_000_000

const isNameStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
const isNameChar = (c: number): boolean => isNameStart(c) || (c >= 48 && c <= 58) || c === 45

/**
 * Extracts the visible text, the title and the links of an HTML document. `baseUrl` resolves relative links.
 * Never throws on malformed input: what cannot be read as a tag is text. The work is linear in the document and
 * bounded: a document over `MAX_HTML_INPUT`, with too many tags, nested too deep or made of broken tags is read
 * as far as those limits allow and the result says `truncated`.
 */
export function extractHtml(input: string, baseUrl: string, maxChars = 100_000): ExtractedPage {
  const html = input.length > MAX_HTML_INPUT ? input.slice(0, MAX_HTML_INPUT) : input
  const out: string[] = []
  let size = 0
  let full = false
  let clipped = input.length > MAX_HTML_INPUT
  let hiddenChars = 0
  let commentChars = 0
  let title: string | null = null
  const links: { url: string; text: string }[] = []
  const seenLinks = new Set<string>()
  /** Open elements that hide their content: the tag name and whether it was skipped as a kind or hidden by markup. */
  const hiding: { tag: string; counted: boolean }[] = []
  /** Where each tag name sits in `hiding`, innermost last, so that a closing tag finds its element without a scan. */
  const hidingAt = new Map<string, number[]>()
  let countedOpen = 0
  let anchor: { url: string; text: string[] } | null = null
  let inTitle = false
  let titleText = ''

  const pushHiding = (tag: string, counted: boolean): boolean => {
    if (hiding.length >= MAX_DEPTH) return false
    hiding.push({ tag, counted })
    const at = hidingAt.get(tag)
    if (at === undefined) hidingAt.set(tag, [hiding.length - 1])
    else at.push(hiding.length - 1)
    if (counted) countedOpen += 1
    return true
  }
  /** Closes the innermost hiding element of this name and everything inside it. */
  const closeHiding = (tag: string): void => {
    const at = hidingAt.get(tag)
    const idx = at?.[at.length - 1]
    if (idx === undefined) return
    while (hiding.length > idx) {
      const h = hiding.pop() as { tag: string; counted: boolean }
      hidingAt.get(h.tag)?.pop()
      if (h.counted) countedOpen -= 1
    }
  }
  const emit = (text: string): void => {
    if (text === '' || full) return
    if (size + text.length > maxChars) {
      out.push(text.slice(0, Math.max(0, maxChars - size)))
      size = maxChars
      full = true
      return
    }
    out.push(text)
    size += text.length
  }
  const text = (raw: string): void => {
    const decoded = collapse(decodeEntities(raw))
    if (inTitle) {
      titleText += decoded
      return
    }
    if (hiding.length > 0) {
      if (countedOpen > 0) hiddenChars += decoded.trim().length
      return
    }
    if (anchor !== null) anchor.text.push(decoded)
    emit(decoded)
  }

  const rawEnds: Record<string, RegExp> = { script: /<\/script/gi, style: /<\/style/gi }
  let failedScan = 0
  let tags = 0
  let nextGt = -1
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      text(html.slice(i))
      break
    }
    if (lt > i) text(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      const stop = end === -1 ? n : end
      commentChars += stop - (lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    // Without a `>` further on nothing below can be a tag, and looking for one at every `<` is what made this quadratic.
    if (nextGt < lt) nextGt = html.indexOf('>', lt)
    if (nextGt === -1) {
      text(html.slice(lt))
      break
    }
    if (failedScan > MAX_FAILED_SCAN) {
      clipped = true
      break
    }
    // A tag by hand: `<`, `/`?, a name, then anything up to the first `>` that is not inside quotes, all within MAX_TAG_LENGTH.
    let p = lt + 1
    const closing = html.charCodeAt(p) === 47
    if (closing) p += 1
    let end = -1
    let nameEnd = p
    if (isNameStart(html.charCodeAt(p))) {
      p += 1
      while (p < n && isNameChar(html.charCodeAt(p))) p += 1
      nameEnd = p
      const limit = Math.min(n, lt + MAX_TAG_LENGTH)
      while (p < limit) {
        const c = html.charCodeAt(p)
        if (c === 62) {
          end = p + 1
          break
        }
        if (c === 34 || c === 39) {
          p += 1
          while (p < limit && html.charCodeAt(p) !== c) p += 1
          if (p >= limit) break
        }
        p += 1
      }
      if (end === -1) failedScan += p - lt
    }
    if (end === -1) {
      // `<!doctype`, `<?xml`, a stray `<`: skip a declaration, keep a lone bracket as text.
      const next = html.charCodeAt(lt + 1)
      let declEnd = -1
      if (next === 33 || next === 63) {
        const limit = Math.min(n, lt + 2000)
        for (let q = lt + 2; q < limit; q += 1) {
          if (html.charCodeAt(q) === 62) {
            declEnd = q + 1
            break
          }
        }
        failedScan += (declEnd === -1 ? limit : declEnd) - lt
      }
      if (declEnd !== -1) i = declEnd
      else {
        text('<')
        i = lt + 1
      }
      continue
    }
    tags += 1
    if (tags > MAX_TAGS) {
      clipped = true
      break
    }
    i = end
    const tag = html.slice(closing ? lt + 2 : lt + 1, nameEnd).toLowerCase()
    const rawAttrs = html.slice(nameEnd, end - 1)
    const selfClosed = rawAttrs.trimEnd().endsWith('/') || VOID.has(tag)

    if (!closing && (tag === 'script' || tag === 'style')) {
      // Raw text elements end at their own closing tag and nowhere else.
      const re = rawEnds[tag] as RegExp
      re.lastIndex = i
      const found = re.exec(html)
      i = found === null ? n : html.indexOf('>', found.index) + 1 || n
      continue
    }
    if (closing) {
      if (tag === 'title' && inTitle) {
        inTitle = false
        if (title === null) title = titleText.replace(/\s+/g, ' ').trim().slice(0, 300) || null
      }
      if (hiding.length > 0) {
        // Close the innermost hiding element of this name; tags inside a hidden region are otherwise ignored.
        closeHiding(tag)
        continue
      }
      if (tag === 'a' && anchor !== null) {
        const label = anchor.text.join('').replace(/\s+/g, ' ').trim().slice(0, 200)
        if (!seenLinks.has(anchor.url) && links.length < 200) {
          seenLinks.add(anchor.url)
          links.push({ url: anchor.url, text: label })
        }
        anchor = null
      }
      if (BLOCK.has(tag)) emit('\n')
      continue
    }
    if (hiding.length > 0) {
      if (!selfClosed && !pushHiding(tag, false)) {
        clipped = true
        break
      }
      continue
    }
    const attrs = attributes(rawAttrs)
    if (tag === 'title' && title === null) {
      inTitle = true
      titleText = ''
      continue
    }
    if (SKIPPED.has(tag)) {
      if (!selfClosed && !pushHiding(tag, false)) {
        clipped = true
        break
      }
      continue
    }
    if (hiddenByMarkup(attrs)) {
      if (!selfClosed && !pushHiding(tag, true)) {
        clipped = true
        break
      }
      continue
    }
    if (BLOCK.has(tag)) emit('\n')
    if (tag === 'td' || tag === 'th') emit(' ')
    if (tag === 'li') emit('- ')
    if (tag === 'img' && attrs['alt']) text(` ${attrs['alt']} `)
    if (tag === 'a' && attrs['href']) {
      try {
        const url = new URL(attrs['href'], baseUrl)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          url.hash = ''
          anchor = { url: url.href, text: [] }
        }
      } catch {
        // not a link
      }
    }
  }
  if (title === null && titleText.trim() !== '') title = titleText.replace(/\s+/g, ' ').trim().slice(0, 300)

  const joined = out
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text: joined, truncated: full || clipped, links, hiddenChars, commentChars }
}

/** Text of a document that is not HTML: plain text, Markdown, JSON. Control characters other than line ends are dropped. */
export function extractPlain(body: string, maxChars = 100_000): { text: string; truncated: boolean } {
  // eslint-disable-next-line no-control-regex
  const clean = body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return { text: clean.slice(0, maxChars), truncated: clean.length > maxChars }
}
