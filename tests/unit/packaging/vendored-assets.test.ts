import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BUSYBOX_SHA256 } from '@main/modules/isolation/shell-adapter'
// @ts-expect-error a build script, plain JavaScript
import { copyVerified, vendoredSha256 } from '../../../scripts/build-launcher.mjs'

// 0.9: a binary NEXUS did not build enters a build only by its recorded hash.
const scratchRoot = resolve('test-results', 'vendored-assets')
mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(join(scratchRoot, 'run-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

describe('vendored binaries', () => {
  it('the busybox in the repository is the one on record, and the record is the one the shell adapter runs', () => {
    const dir = resolve('vendor', 'busybox')
    const recorded = vendoredSha256(dir) as string
    expect(recorded).toBe(BUSYBOX_SHA256)
    expect(sha256(readFileSync(join(dir, 'busybox.exe')))).toBe(recorded)
    expect(existsSync(join(dir, 'COPYING'))).toBe(true)
  })

  it('a file with the recorded hash is copied, and copied again over a destination that differs', () => {
    const source = join(scratch, 'good.bin')
    const destination = join(scratch, 'out-good.bin')
    writeFileSync(source, 'the real one')
    copyVerified(source, destination, sha256('the real one'))
    expect(readFileSync(destination, 'utf8')).toBe('the real one')
    writeFileSync(destination, 'replaced behind the build')
    copyVerified(source, destination, sha256('the real one'))
    expect(readFileSync(destination, 'utf8')).toBe('the real one')
  })

  it('a file with another hash stops the build and nothing is copied', () => {
    const source = join(scratch, 'swapped.bin')
    const destination = join(scratch, 'out-swapped.bin')
    writeFileSync(source, 'not the one on record')
    expect(() => copyVerified(source, destination, sha256('the real one'))).toThrow(/not the file on record/)
    expect(existsSync(destination)).toBe(false)
  })

  it('a record without a hash is refused', () => {
    const dir = join(scratch, 'no-hash')
    mkdirSync(dir)
    writeFileSync(join(dir, 'PROVENANCE.json'), JSON.stringify({ name: 'x', sha256: 'latest' }))
    expect(() => vendoredSha256(dir)).toThrow(/names no SHA-256/)
  })
})
