import { describe, expect, it } from 'vitest'
import { extractImports, parseGoMod } from '@main/modules/intelligence/parsers'

const HOSTILE_BYTES = 200 * 1024

describe('Go parsing is linear', () => {
  it('parses import blocks and require blocks', () => {
    const src = ['package x', 'import "fmt"', 'import (', '\t"os"', '\tlog "log"', ')', 'import (', '\t"net/http"', ')'].join('\n')
    expect(extractImports('go', src).sort()).toEqual(['fmt', 'log', 'net/http', 'os'])
    const mod = ['module example.com/m', '', 'require (', '\tgithub.com/a/b v1.2.3', '\tgithub.com/c/d v0.1.0 // indirect', ')', 'require github.com/e/f v2.0.0'].join('\n')
    expect(parseGoMod(mod)).toEqual({
      module: 'example.com/m',
      deps: [
        { name: 'github.com/a/b', spec: 'v1.2.3' },
        { name: 'github.com/e/f', spec: 'v2.0.0' },
      ],
    })
  })

  it('a 200 KB file of unterminated "import (" lines is parsed quickly', () => {
    const text = 'import (\n'.repeat(HOSTILE_BYTES / 9)
    const started = performance.now()
    extractImports('go', text)
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('a 200 KB go.mod of unterminated "require (" lines is parsed quickly', () => {
    const text = 'require (\n'.repeat(HOSTILE_BYTES / 10)
    const started = performance.now()
    parseGoMod(text)
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('an unterminated block that is long and made of quoted lines stays linear too', () => {
    const text = `import (\n${'\t"a/b"\n'.repeat(HOSTILE_BYTES / 8)}`
    const started = performance.now()
    expect(extractImports('go', text)).toEqual(['a/b'])
    expect(performance.now() - started).toBeLessThan(250)
  })
})
