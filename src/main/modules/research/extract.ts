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

/**
 * Extracts the visible text, the title and the links of an HTML document. `baseUrl` resolves relative links.
 * Never throws on malformed input: what cannot be read as a tag is text.
 */
export function extractHtml(html: string, baseUrl: string, maxChars = 100_000): ExtractedPage {
  const out: string[] = []
  let size = 0
  let truncated = false
  let hiddenChars = 0
  let commentChars = 0
  let title: string | null = null
  const links: { url: string; text: string }[] = []
  const seenLinks = new Set<string>()
  /** Open elements that hide their content: the tag name and whether it was skipped as a kind or hidden by markup. */
  const hiding: { tag: string; counted: boolean }[] = []
  let anchor: { url: string; text: string[] } | null = null
  let inTitle = false
  let titleText = ''

  const emit = (text: string): void => {
    if (text === '' || truncated) return
    if (size + text.length > maxChars) {
      out.push(text.slice(0, Math.max(0, maxChars - size)))
      size = maxChars
      truncated = true
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
      if (hiding.some((h) => h.counted)) hiddenChars += decoded.trim().length
      return
    }
    if (anchor !== null) anchor.text.push(decoded)
    emit(decoded)
  }

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
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(lt, lt + 20_000))
    if (m === null) {
      // `<!doctype`, `<?xml`, a stray `<`: skip a declaration, keep a lone bracket as text.
      const decl = /^<[!?][^>]*>/.exec(html.slice(lt, lt + 2000))
      if (decl !== null) i = lt + decl[0].length
      else {
        text('<')
        i = lt + 1
      }
      continue
    }
    i = lt + m[0].length
    const closing = m[1] === '/'
    const tag = (m[2] as string).toLowerCase()
    const selfClosed = (m[3] as string).trimEnd().endsWith('/') || VOID.has(tag)

    if (!closing && (tag === 'script' || tag === 'style')) {
      // Raw text elements end at their own closing tag and nowhere else.
      const end = html.toLowerCase().indexOf(`</${tag}`, i)
      i = end === -1 ? n : html.indexOf('>', end) + 1 || n
      continue
    }
    if (closing) {
      if (tag === 'title' && inTitle) {
        inTitle = false
        if (title === null) title = titleText.replace(/\s+/g, ' ').trim().slice(0, 300) || null
      }
      const top = hiding[hiding.length - 1]
      if (top !== undefined) {
        // Close the innermost hiding element of this name; tags inside a hidden region are otherwise ignored.
        const idx = hiding.map((h) => h.tag).lastIndexOf(tag)
        if (idx !== -1) hiding.length = idx
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
    const attrs = attributes(m[3] as string)
    if (hiding.length > 0) {
      if (!selfClosed) hiding.push({ tag, counted: false })
      continue
    }
    if (tag === 'title' && title === null) {
      inTitle = true
      titleText = ''
      continue
    }
    if (SKIPPED.has(tag)) {
      if (!selfClosed) hiding.push({ tag, counted: false })
      continue
    }
    if (hiddenByMarkup(attrs)) {
      if (!selfClosed) hiding.push({ tag, counted: true })
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
  return { title, text: joined, truncated, links, hiddenChars, commentChars }
}

/** Text of a document that is not HTML: plain text, Markdown, JSON. Control characters other than line ends are dropped. */
export function extractPlain(body: string, maxChars = 100_000): { text: string; truncated: boolean } {
  // eslint-disable-next-line no-control-regex
  const clean = body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return { text: clean.slice(0, maxChars), truncated: clean.length > maxChars }
}
