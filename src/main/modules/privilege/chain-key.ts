import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProtectedStorage } from '../intelligence/connection'

/** The anchor of the receipt chain: its head and the legacy boundary, authenticated by an HMAC the caller computes. */
export interface ChainAnchor {
  headChainSeq: number
  headHash: string
  legacyMaxSeq: number
  legacyCount: number
  hmac: string
}

export type ChainVaultState =
  | { state: 'READY'; key: Buffer; anchor: ChainAnchor | null }
  | { state: 'ABSENT' }
  | { state: 'UNAVAILABLE'; reason: string }

const UNREADABLE = 'the receipt-chain key could not be read'
const NO_STORAGE = 'The protected storage of Windows is not available, so the receipt-chain key was not kept.'

/**
 * The key of the receipt chain and its anchor, in one file encrypted by the protected storage (as the Director Line's
 * secrets). Nothing is written in the clear; a file that exists but cannot be read is never replaced.
 */
export function receiptChainVault(dir: string, storage: ProtectedStorage | undefined) {
  const file = join(dir, 'receipt-chain.bin')

  const load = (): ChainVaultState => {
    if (storage === undefined || !storage.available()) return { state: 'UNAVAILABLE', reason: NO_STORAGE }
    if (!existsSync(file)) return { state: 'ABSENT' }
    try {
      const parsed = JSON.parse(storage.decrypt(readFileSync(file))) as { v?: unknown; key?: unknown; anchor?: unknown }
      if (parsed.v !== 1 || typeof parsed.key !== 'string') return { state: 'UNAVAILABLE', reason: UNREADABLE }
      const key = Buffer.from(parsed.key, 'base64')
      if (key.length !== 32) return { state: 'UNAVAILABLE', reason: UNREADABLE }
      const a = parsed.anchor as Partial<ChainAnchor> | null | undefined
      if (a === null || a === undefined) return { state: 'READY', key, anchor: null }
      if (
        !Number.isInteger(a.headChainSeq) || typeof a.headHash !== 'string' || !Number.isInteger(a.legacyMaxSeq) ||
        !Number.isInteger(a.legacyCount) || typeof a.hmac !== 'string'
      ) return { state: 'UNAVAILABLE', reason: UNREADABLE }
      const anchor: ChainAnchor = { headChainSeq: a.headChainSeq as number, headHash: a.headHash, legacyMaxSeq: a.legacyMaxSeq as number, legacyCount: a.legacyCount as number, hmac: a.hmac }
      return { state: 'READY', key, anchor }
    } catch {
      return { state: 'UNAVAILABLE', reason: UNREADABLE }
    }
  }

  const write = (key: Buffer, anchor: ChainAnchor | null): void => {
    if (storage === undefined || !storage.available()) throw new Error(NO_STORAGE)
    const sealed = storage.encrypt(JSON.stringify({ v: 1, key: key.toString('base64'), anchor }))
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, sealed)
    renameSync(tmp, file)
  }

  return {
    load,
    create(): Buffer {
      const current = load()
      if (current.state === 'UNAVAILABLE') throw new Error(current.reason)
      if (current.state === 'READY' || existsSync(file)) throw new Error('The receipt-chain key already exists.')
      const key = randomBytes(32)
      write(key, null)
      return key
    },
    saveAnchor(anchor: ChainAnchor): void {
      const current = load()
      if (current.state !== 'READY') throw new Error(current.state === 'UNAVAILABLE' ? current.reason : 'There is no receipt-chain key to anchor.')
      write(current.key, anchor)
    },
  }
}
