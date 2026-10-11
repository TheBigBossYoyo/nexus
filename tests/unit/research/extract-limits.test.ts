import { describe, expect, it } from 'vitest'
import { MAX_HTML_INPUT, extractHtml } from '@main/modules/research/extract'

// The audit measured minutes on hostile documents: a `<` that is not a tag looked at a window of 20 000
// characters, every raw-text element lowercased the whole document again, and every closing tag scanned the
// stack of hidden elements. Each input below is one of the measured ones at 1 MiB (or 4 MiB where it was
// measured so); the bound is loose, the old code needed 6 to 210 seconds.
const MIB = 1024 * 1024
const BOUND_MS = 2000

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = run()
  return { value, ms: performance.now() - start }
}

describe('extractHtml on hostile documents', () => {
  const cases: [string, string][] = [
    ['256 KiB of "<a" with no ">"', '<a'.repeat(128 * 1024)],
    ['1 MiB of "<a" with no ">"', '<a'.repeat(MIB / 2)],
    ['1 MiB of "<a" and a ">" at the very end', `${'<a'.repeat(MIB / 2)}>`],
    ['1 MiB of empty script elements', '<script></script>'.repeat(Math.floor(MIB / 17))],
    ['4 MiB of empty script elements', '<script></script>'.repeat(Math.floor((4 * MIB) / 17))],
    ['1 MiB of empty style elements', '<style></style>'.repeat(Math.floor(MIB / 15))],
    ['a hidden element holding 60 000 opening and 60 000 closing tags', `<div hidden>${'<b>'.repeat(60_000)}${'</b>'.repeat(60_000)}</div>`],
    ['1 MiB of quote-opening fragments', `<a "`.repeat(MIB / 4)],
    ['1 MiB of unterminated comments and declarations', '<!x<!--'.repeat(MIB / 7)],
    ['1 MiB of nested hidden elements', `<div hidden>${'<div>'.repeat(MIB / 5 - 20)}`],
  ]
  for (const [name, html] of cases) {
    it(`reads ${name} in well under ${BOUND_MS} ms`, () => {
      const { value, ms } = timed(() => extractHtml(html, 'https://example.org/'))
      expect(ms, `${name}: ${Math.round(ms)} ms`).toBeLessThan(BOUND_MS)
      expect(typeof value.text).toBe('string')
      if (html.length > MAX_HTML_INPUT) expect(value.truncated).toBe(true)
    })
  }

  it('closes hundreds of nested hidden elements and goes on reading after them', () => {
    const { value, ms } = timed(() => extractHtml(`<div hidden>${'<b>'.repeat(400)}${'</b>'.repeat(400)}text</div><p>after</p>`, 'https://example.org/'))
    expect(ms).toBeLessThan(BOUND_MS)
    expect(value.text).toBe('after')
    expect(value.hiddenChars).toBe(4)
    expect(value.truncated).toBe(false)
  })

  it('reads an input over the cap as far as the cap and says so', () => {
    const html = `<p>first</p>${'x'.repeat(MAX_HTML_INPUT)}<p>after the cap</p>`
    const page = extractHtml(html, 'https://example.org/', 10_000_000)
    expect(page.truncated).toBe(true)
    expect(page.text).toContain('first')
    expect(page.text).not.toContain('after the cap')
  })

  it('stops, and says so, at a nesting that is not a page', () => {
    const page = extractHtml(`<p>kept</p><div hidden>${'<div>'.repeat(5000)}</div>`, 'https://example.org/')
    expect(page.truncated).toBe(true)
    expect(page.text).toBe('kept')
  })

  it('still closes hidden elements by name, innermost first, as before', () => {
    const page = extractHtml('<p>a</p><div hidden>x<span>y</span>z<div>q</div>w</div><p>b</p><section aria-hidden="true">1<b>2</b></i>3</section>4', 'https://example.org/')
    expect(page.text).toBe('a\n\nb\n4')
    expect(page.hiddenChars).toBe(['x', 'y', 'z', 'q', 'w', '1', '2', '3'].length)
    expect(page.truncated).toBe(false)
  })
})
