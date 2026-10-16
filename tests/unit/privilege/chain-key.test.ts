import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { receiptChainVault } from '@main/modules/privilege/chain-key'
import type { ProtectedStorage } from '@main/modules/intelligence/connection'

const MARK = 'FAKE-DPAPI:'
function fakeStorage(opts: { available?: boolean; throwOnEncrypt?: boolean } = {}): ProtectedStorage {
  return {
    available: () => opts.available ?? true,
    encrypt: (v) => {
      if (opts.throwOnEncrypt) throw new Error('encrypt failed')
      return Buffer.from(MARK + Buffer.from(v, 'utf8').reverse().toString('base64'))
    },
    decrypt: (b) => {
      const s = b.toString('utf8')
      if (!s.startsWith(MARK)) throw new Error('not decryptable')
      return Buffer.from(s.slice(MARK.length), 'base64').reverse().toString('utf8')
    },
  }
}

const anchor = { headChainSeq: 4, headHash: 'ab'.repeat(32), legacyMaxSeq: 2, legacyCount: 2, hmac: 'cd'.repeat(32) }

describe('receipt-chain vault', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chain-key-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('is ABSENT, then create() makes it READY with the same key', () => {
    const vault = receiptChainVault(dir, fakeStorage())
    expect(vault.load()).toEqual({ state: 'ABSENT' })
    const key = vault.create()
    expect(key).toHaveLength(32)
    const loaded = vault.load()
    expect(loaded.state).toBe('READY')
    if (loaded.state === 'READY') {
      expect(loaded.key.equals(key)).toBe(true)
      expect(loaded.anchor).toBeNull()
    }
    expect(() => vault.create()).toThrow()
    const again = vault.load()
    expect(again.state === 'READY' && again.key.equals(key)).toBe(true)
  })

  it('round-trips the anchor and keeps the key', () => {
    const vault = receiptChainVault(dir, fakeStorage())
    const key = vault.create()
    vault.saveAnchor(anchor)
    const loaded = receiptChainVault(dir, fakeStorage()).load()
    expect(loaded.state).toBe('READY')
    if (loaded.state === 'READY') {
      expect(loaded.key.equals(key)).toBe(true)
      expect(loaded.anchor).toEqual(anchor)
    }
  })

  it('is UNAVAILABLE without usable storage and writes nothing', () => {
    for (const storage of [undefined, fakeStorage({ available: false })]) {
      const vault = receiptChainVault(dir, storage)
      expect(vault.load().state).toBe('UNAVAILABLE')
      expect(() => vault.create()).toThrow()
      expect(() => vault.saveAnchor(anchor)).toThrow()
    }
    expect(existsSync(join(dir, 'receipt-chain.bin'))).toBe(false)
  })

  it('writes nothing when encrypt throws', () => {
    const vault = receiptChainVault(dir, fakeStorage({ throwOnEncrypt: true }))
    expect(() => vault.create()).toThrow('encrypt failed')
    expect(existsSync(join(dir, 'receipt-chain.bin'))).toBe(false)
  })

  it('reports a corrupted file UNAVAILABLE and never overwrites it', () => {
    const file = join(dir, 'receipt-chain.bin')
    for (const bytes of [Buffer.from('garbage'), Buffer.from(MARK + 'AAAA'), fakeStorage().encrypt('not json')]) {
      writeFileSync(file, bytes)
      const vault = receiptChainVault(dir, fakeStorage())
      const state = vault.load()
      expect(state).toEqual({ state: 'UNAVAILABLE', reason: 'the receipt-chain key could not be read' })
      expect(() => vault.create()).toThrow()
      expect(() => vault.saveAnchor(anchor)).toThrow()
      expect(readFileSync(file).equals(bytes)).toBe(true)
    }
  })

  it('does not keep the key in the clear', () => {
    const vault = receiptChainVault(dir, fakeStorage())
    const key = vault.create()
    vault.saveAnchor(anchor)
    const raw = readFileSync(join(dir, 'receipt-chain.bin')).toString('latin1')
    expect(raw).not.toContain(key.toString('hex'))
    expect(raw).not.toContain(key.toString('base64'))
    expect(raw).not.toContain('"key"')
  })
})
