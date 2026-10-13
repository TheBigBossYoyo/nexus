// 0.9: the Authenticode state of every program file in a package or a release folder, as Windows judges it.
//
//   node scripts/verify-signatures.mjs <dir-or-file> [--require-signed] [--json]
//
// Without a certificate nothing of NEXUS's own is signed, and this says so file by file; it fails only when a
// signature is present and does not hold (a file changed after it was signed). With --require-signed it also
// fails when a file NEXUS is responsible for carries no valid signature: the check a signed release must pass.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROGRAM = new Set(['.exe', '.dll', '.node', '.ps1', '.psm1', '.msi', '.sys'])
/** Programs for another system that a Windows package may carry: Windows has nothing to say about them. */
const FOREIGN = /[\\/](darwin|linux|linuxmusl|android|freebsd)[-\\/]/i

function* programs(path) {
  const stat = statSync(path)
  if (stat.isFile()) {
    if (PROGRAM.has(extname(path).toLowerCase())) yield path
  } else if (stat.isDirectory()) for (const entry of readdirSync(path, { withFileTypes: true })) yield* programs(join(path, entry.name))
}

/** Asks Windows about each file. One PowerShell for all of them; paths go through a file, not a command line. */
export function signatureStates(files) {
  if (files.length === 0) return []
  const scratch = join(resolve(import.meta.dirname, '..'), 'test-results', 'verify-signatures')
  mkdirSync(scratch, { recursive: true })
  const list = join(scratch, `files-${process.pid}.txt`)
  writeFileSync(list, files.join('\n'), 'utf8')
  try {
    const script = `$ErrorActionPreference='Stop'; Get-Content -LiteralPath '${list.replace(/'/g, "''")}' -Encoding UTF8 | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; [pscustomobject]@{ file = "$_"; status = [string]$s.Status; signer = [string]$s.SignerCertificate.Subject; timestamped = ($null -ne $s.TimeStamperCertificate) } } | ConvertTo-Json -Compress`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim()
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } finally {
    rmSync(list, { force: true })
  }
}

/**
 * Judges a set of states. `broken`: a signature is there and does not hold. `unsigned`: no signature on a file
 * of this system. A file signed by somebody else (the SDK's claude.exe, Windows' own libraries) counts as signed.
 */
export function judgeSignatures(states, { requireSigned = false } = {}) {
  const relevant = states.filter((s) => !FOREIGN.test(s.file))
  const broken = relevant.filter((s) => s.status !== 'Valid' && s.status !== 'NotSigned')
  const unsigned = relevant.filter((s) => s.status === 'NotSigned')
  const signed = relevant.filter((s) => s.status === 'Valid')
  const untimestamped = signed.filter((s) => !s.timestamped)
  const problems = [...broken.map((s) => `${s.file}: the signature does not hold (${s.status})`), ...(requireSigned ? [...unsigned.map((s) => `${s.file}: not signed`), ...untimestamped.map((s) => `${s.file}: signed without a timestamp`)] : [])]
  return { files: relevant.length, signed: signed.length, unsigned: unsigned.length, broken: broken.length, untimestamped: untimestamped.length, foreign: states.length - relevant.length, ok: problems.length === 0, problems }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const target = args.find((a) => !a.startsWith('--'))
  if (!target || !existsSync(target)) throw new Error('usage: verify-signatures.mjs <dir-or-file> [--require-signed] [--json]')
  const root = resolve(target)
  const states = signatureStates([...programs(root)])
  const verdict = judgeSignatures(states, { requireSigned: args.includes('--require-signed') })
  if (args.includes('--json')) console.log(JSON.stringify({ root, verdict, states }, null, 2))
  else {
    for (const s of states) console.log(`${s.status.padEnd(13)} ${(s.signer.match(/CN="?([^",]+)/)?.[1] ?? '').padEnd(28)} ${relative(root, s.file) || s.file}`)
    console.log(JSON.stringify({ ...verdict, problems: verdict.problems.length }))
    for (const p of verdict.problems) console.log(`PROBLEM ${p}`)
  }
  if (!verdict.ok) process.exitCode = 1
}
