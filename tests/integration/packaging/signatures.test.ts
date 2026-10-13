import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, rmSync, writeSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error a script, plain JavaScript
import { judgeSignatures, signatureStates } from '../../../scripts/verify-signatures.mjs'

// 0.9: what the release check says about signatures. NEXUS owns no certificate, so the one signed program at
// hand is used: the claude.exe the Agent SDK ships, signed by Anthropic. Changing one byte of a copy must turn
// its signature from valid to broken, and the check must fail on that and on nothing else.
const signedProgram = resolve('node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
const d = process.platform === 'win32' && existsSync(signedProgram) ? describe : describe.skip
const scratch = resolve('test-results', 'signature-tests')
afterAll(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

interface State { file: string; status: string; signer: string; timestamped: boolean }

d('signatures of a package', () => {
  it('a signed program is valid; the same program with one byte changed is not, and the check fails on it', () => {
    mkdirSync(scratch, { recursive: true })
    const intact = join(scratch, 'intact.exe')
    const changed = join(scratch, 'changed.exe')
    copyFileSync(signedProgram, intact)
    copyFileSync(signedProgram, changed)
    // One byte in the middle of the file, inside what the signature covers.
    const at = Math.floor(statSync(changed).size / 2)
    const fd = openSync(changed, 'r+')
    const byte = Buffer.alloc(1)
    readSync(fd, byte, 0, 1, at)
    byte[0] = (byte[0] as number) ^ 0xff
    writeSync(fd, byte, 0, 1, at)
    closeSync(fd)

    const states = signatureStates([intact, changed]) as State[]
    const of = (file: string): State => states.find((s) => s.file === file) as State
    expect(of(intact).status).toBe('Valid')
    expect(of(intact).signer).toContain('Anthropic')
    expect(of(intact).timestamped).toBe(true)
    expect(of(changed).status).toBe('HashMismatch')

    expect(judgeSignatures([of(intact)], { requireSigned: true })).toMatchObject({ ok: true, signed: 1 })
    const verdict = judgeSignatures(states)
    expect(verdict.ok).toBe(false)
    expect(verdict.broken).toBe(1)
    expect(verdict.problems[0]).toContain('does not hold')
  }, 120_000)

  it('an unsigned program passes the plain check, is counted, and fails the check of a signed release', () => {
    const unsigned: State = { file: 'C:\\pkg\\resources\\bin\\nexus-launch.exe', status: 'NotSigned', signer: '', timestamped: false }
    expect(judgeSignatures([unsigned])).toMatchObject({ ok: true, unsigned: 1 })
    expect(judgeSignatures([unsigned], { requireSigned: true })).toMatchObject({ ok: false })
  })

  it('a signature without a timestamp fails the check of a signed release: it ends with the certificate', () => {
    const signed: State = { file: 'C:\\pkg\\NEXUS.exe', status: 'Valid', signer: 'CN=Somebody', timestamped: false }
    expect(judgeSignatures([signed])).toMatchObject({ ok: true })
    expect(judgeSignatures([signed], { requireSigned: true }).problems[0]).toContain('without a timestamp')
  })

  it("a program for another system is not Windows' to judge", () => {
    const foreign: State = { file: 'C:\\pkg\\node_modules\\better-sqlite3\\prebuilds\\darwin-arm64.node', status: 'UnknownError', signer: '', timestamped: false }
    expect(judgeSignatures([foreign], { requireSigned: true })).toMatchObject({ ok: true, files: 0, foreign: 1 })
  })
})
