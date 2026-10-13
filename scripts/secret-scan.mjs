// 0.9: looks for credentials in what NEXUS writes and in what a release publishes: runtime and mission logs,
// evidence files, reports, test artifacts. It reads; it changes nothing.
//
//   node scripts/secret-scan.mjs [path ...]        default: every tracked file under docs/, and release/v<version>/
//   node scripts/secret-scan.mjs --json <path>
//
// A finding prints the file, the line, the kind and the first and last characters of the match, never the match.
// Exit code 1 when anything is found.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What a credential looks like. Each pattern names a kind; `g` flags are required. */
export const SECRET_PATTERNS = [
  { kind: 'Anthropic key or OAuth token', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'OpenAI key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'npm credential line', pattern: /(?:_authToken|_auth|_password)\s*=\s*(?!\$\{)[^\s"'<>*]{8,}/g },
  { kind: 'Authorization header', pattern: /\bauthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { kind: 'Bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g },
  { kind: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'OAuth token field', pattern: /"(?:refresh_token|access_token|id_token|client_secret|refreshToken|accessToken)"\s*:\s*"[^"\s]{20,}"/g },
  { kind: 'Cookie header', pattern: /\b(?:set-)?cookie["']?\s*[:=]\s*["']?[A-Za-z0-9_.-]+=[^;\s"']{16,}/gi },
  { kind: 'Slack token', pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { kind: 'Credential in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'<>]{1,64}:[^\s/@"'<>]{6,}@[A-Za-z0-9.-]+/g },
]

/**
 * Values the tests and the documents use on purpose: sentinels a containment test tries to read, and placeholder
 * credentials that name themselves as such. A match that contains one of these is not a finding.
 */
export const KNOWN_FAKES = [/SENTINEL/i, /EXAMPLE/i, /PLACEHOLDER/i, /REDACTED/i, /\bfake\b/i, /\bdummy\b/i, /not-a-real/i, /x{8,}/i, /0{12,}/, /1234567890/, /abcdef/i, /user:pass(word)?@/i, /\*\*\*/, /<[a-z -]+>/i, /\.\.\./]

const TEXT = new Set(['.json', '.jsonl', '.md', '.txt', '.log', '.yml', '.yaml', '.html', '.csv', '.ndjson', '.ts', '.mjs', '.js', '.ps1', '.sh', '.env', '.npmrc', '.toml', '.ini', ''])

/** The findings in one text. `allowFakes: false` reports the deliberate ones too. */
export function scanText(text, { allowFakes = true } = {}) {
  const findings = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.length > 200_000) continue
    for (const { kind, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0
      let m
      while ((m = pattern.exec(line)) !== null) {
        const value = m[0]
        if (allowFakes && KNOWN_FAKES.some((fake) => fake.test(value))) continue
        // The header of a key is a string every TLS library carries; a key is a header with a body after it.
        if (kind === 'Private key' && !/^(?:\[rn]|\s)*[A-Za-z0-9+/=]{40,}/.test(line.slice(m.index + value.length) + (lines[i + 1] ?? ''))) continue
        findings.push({ line: i + 1, kind, shown: `${value.slice(0, 6)}…${value.slice(-2)} (${value.length} characters)` })
      }
    }
  }
  return findings
}

// Other people's code and its compiled forms: not something NEXUS wrote.
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'node-compile-cache'])

function* files(path) {
  const stat = statSync(path)
  if (stat.isFile()) yield path
  else if (stat.isDirectory()) for (const entry of readdirSync(path, { withFileTypes: true })) if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* files(join(path, entry.name))
}

export function scanPaths(paths, options = {}) {
  const findings = []
  let scanned = 0
  for (const path of paths) {
    if (!existsSync(path)) continue
    for (const file of files(path)) {
      if (!TEXT.has(extname(file).toLowerCase()) || statSync(file).size > 64 * 1024 * 1024) continue
      scanned += 1
      for (const finding of scanText(readFileSync(file, 'utf8'), options)) findings.push({ file, ...finding })
    }
  }
  return { scanned, findings }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..')
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  let paths = args.filter((a) => !a.startsWith('--')).map((a) => resolve(a))
  if (paths.length === 0) {
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    paths = execFileSync('git', ['ls-files', 'docs'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((f) => join(root, f))
    paths.push(join(root, 'release', `v${version}`))
  }
  const result = scanPaths(paths)
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    for (const f of result.findings) console.log(`${f.file}:${f.line}  ${f.kind}  ${f.shown}`)
    console.log(`${result.scanned} files read, ${result.findings.length} findings`)
  }
  if (result.findings.length > 0) process.exitCode = 1
}
