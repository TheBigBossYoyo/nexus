import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Package-manager configuration as engineering facts. The `.npmrc` of a project is a credential file as far as
 * the policy is concerned (a registry token lives there), and that stays: an agent that reads the raw file is
 * asking for a boundary. But the question an agent usually has is "why did the install script not run" or
 * "which registry does this use", and that does not need a token. This module reads the configuration in
 * trusted code and says only what is known to be harmless.
 *
 * The rule is an allowlist. A key is reported with its value only when it is on the list below and its value
 * has the shape that key can have (a boolean, a number, a host, a version range). Everything else is reported by
 * name at most, with the value replaced by a fixed marker: a key nobody listed may be a credential under a name
 * nobody thought of, and the cost of hiding a harmless one is a line of text.
 */

export const REDACTED = '[redacted]'
/** The most of any file that is read. A configuration file larger than this is not one. */
export const MAX_CONFIG_BYTES = 256 * 1024
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024
/** Entries kept of any list in the report, so that a hostile file cannot make the answer long. */
const MAX_LIST = 40
const MAX_LINES = 2000

export interface HostSetting {
  /** The key as the file wrote it (an allowlisted name). */
  key: string
  /** Host and path only: no scheme userinfo, query or fragment, and no path segment that looks like a token. */
  where: string
}

export interface PackageConfigReport {
  directory: string
  /** What happened to `.npmrc`: read, absent, or not read (and why). */
  npmrc: { status: 'read' | 'absent' | 'not-read'; reason?: string }
  registries: { default: string | null; scopes: { scope: string; where: string }[] }
  /** Keys that change how installs behave, with a value of the shape the key allows. */
  behavior: Record<string, string>
  /** Mirrors and download locations of binaries (Electron, Sass, Puppeteer, Playwright). */
  downloads: HostSetting[]
  proxy: { key: string; host: string }[]
  cache: { key: string; location: string }[]
  /** "A credential is configured for host X": the host, never the value, and the kind of credential from a fixed list. */
  credentials: { host: string | null; kinds: string[] }[]
  /** Keys that were not on the list. Name only. */
  otherKeys: { key: string; value: typeof REDACTED }[]
  /** Counts of what was left out, so that a short list is not read as a complete one. */
  omitted: number
  packageJson: PackageJsonFacts | null
  lockfiles: string[]
  workspaceYaml: { present: boolean; onlyBuiltDependencies?: string[]; ignoredBuiltDependencies?: string[]; neverBuiltDependencies?: string[] }
  /** Other configuration files that exist. Their contents are not read. */
  otherConfigFiles: string[]
  userLevelNpmrc: { present: boolean | null; note: string }
  appliesToCommands: string
}

export interface PackageJsonFacts {
  packageManager?: string
  engines?: Record<string, string>
  pnpm?: { onlyBuiltDependencies?: string[]; neverBuiltDependencies?: string[]; ignoredBuiltDependencies?: string[] }
  trustedDependencies?: string[]
  /** Names of the lifecycle scripts that exist. Never their text. */
  lifecycleScripts: string[]
}

// -- npmrc ------------------------------------------------------------------------------------------------------

const BOOLEAN_KEYS = new Set([
  'ignore-scripts', 'engine-strict', 'legacy-peer-deps', 'strict-peer-deps', 'save-exact', 'package-lock', 'shamefully-hoist',
  'auto-install-peers', 'enable-pre-post-scripts', 'shell-emulator', 'prefer-offline', 'offline', 'strict-ssl', 'prefer-online',
])
const NUMBER_KEYS = new Set(['fetch-retries', 'fetch-timeout', 'fetch-retry-mintimeout', 'fetch-retry-maxtimeout'])
const ENUM_KEYS: Record<string, readonly string[]> = { 'node-linker': ['isolated', 'hoisted', 'pnp'], 'package-import-method': ['auto', 'hardlink', 'copy', 'clone', 'clone-or-copy'] }
/** Present or absent is all that is said about these: the value is a program or a path of the user. */
const PRESENCE_KEYS = new Set(['script-shell'])
const PROXY_KEYS = new Set(['proxy', 'https-proxy', 'noproxy'])
const CACHE_KEYS = new Set(['cache', 'store-dir', 'virtual-store-dir'])
/** Download mirrors and binary locations of tools that fetch a program at install time. */
const DOWNLOAD_KEY = /^(electron|sass-binary|node-sass|puppeteer|playwright|chromedriver|geckodriver|cypress|sharp|phantomjs|prisma|canvas)(-[a-z0-9]+)*$/
/** Names whose value is a credential or a path to one, whatever else is true of the key. */
const CREDENTIAL_KEY = /token|secret|passw|auth|credential|cert|key$|^ca$|cafile|^username$|^email$|_auth/i
/** The kinds of credential that are named in the report; any other credential-like key is "other". */
const CREDENTIAL_KINDS = ['_auth', '_authtoken', '_password', 'username', 'email', 'certfile', 'keyfile', 'cafile', 'cert', 'key', 'ca', 'tokenhelper', 'always-auth']

interface Entry {
  key: string
  value: string
}

/** ini as npm reads it, as far as the keys that matter: `key=value`, bare `key` is true, `;` and `#` start a comment. */
export function parseNpmrc(text: string): Entry[] {
  const entries: Entry[] = []
  let lines = 0
  for (const raw of text.split(/\r?\n/)) {
    if (++lines > MAX_LINES) break
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    const key = (eq === -1 ? line : line.slice(0, eq)).trim().replace(/\[\]$/, '')
    let value = eq === -1 ? 'true' : line.slice(eq + 1).trim()
    // An unquoted value ends where a comment begins.
    if (!/^["']/.test(value)) value = value.replace(/\s+[;#].*$/, '')
    value = value.replace(/^(["'])(.*)\1$/, '$2')
    if (key !== '') entries.push({ key, value })
  }
  return entries
}

function plainKey(key: string): string {
  return key.toLowerCase().replace(/_/g, '-')
}

/** A key name that is safe to print: its characters are limited and its length is cut. */
function printableKey(key: string): string {
  return key.replace(/[^\w.@:/\-]/g, '?').slice(0, 80)
}

const HOSTNAME = /^[a-z0-9.\-_[\]:]{1,255}$/i
// A path segment of 24 characters or more that mixes letters and digits is how a token travels in a URL.
const looksLikeToken = (seg: string): boolean => seg.length >= 24 && /[A-Za-z]/.test(seg) && /\d/.test(seg)

/** host/path of an address, with scheme, userinfo, query and fragment gone. Null: not an address, or one that holds an environment reference. */
export function hostAndPath(value: string): string | null {
  if (value === '' || value.includes('${')) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value.replace(/^\/\//, '')}`)
  } catch {
    return null
  }
  if (!HOSTNAME.test(url.host)) return null
  const segments = url.pathname.split('/').map((s) => (looksLikeToken(s) ? '[segment]' : s.replace(/[^\w.@%~+\-]/g, '?')))
  return `${url.host.toLowerCase()}${segments.join('/')}`.slice(0, 200)
}

function hostOnly(value: string): string | null {
  const hp = hostAndPath(value)
  return hp === null ? null : (hp.split('/')[0] ?? null)
}

/** Where a path points relative to the project, without printing it. */
function placeOf(value: string, projectDir: string): string {
  if (value.includes('${')) return 'set from an environment variable'
  if (value.startsWith('~')) return 'outside the project'
  const resolved = path.resolve(projectDir, value)
  const rel = path.relative(projectDir, resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? 'inside the project' : 'outside the project'
}

type Scratch = Pick<PackageConfigReport, 'registries' | 'behavior' | 'downloads' | 'proxy' | 'cache' | 'credentials' | 'otherKeys' | 'omitted'>

function addCredential(s: Scratch, host: string | null, kind: string): void {
  const k = CREDENTIAL_KINDS.includes(kind.toLowerCase()) ? kind : 'other'
  const existing = s.credentials.find((c) => c.host === host)
  if (existing === undefined) s.credentials.push({ host, kinds: [k] })
  else if (!existing.kinds.includes(k)) existing.kinds.push(k)
}

function classify(entries: Entry[], projectDir: string): Scratch {
  const s: Scratch = { registries: { default: null, scopes: [] }, behavior: {}, downloads: [], proxy: [], cache: [], credentials: [], otherKeys: [], omitted: 0 }
  // The last assignment of a key wins, as it does for npm.
  const last = new Map<string, Entry>()
  for (const e of entries) last.set(e.key, e)
  for (const { key, value } of last.values()) {
    // `//registry.example.com/:_authToken`: everything after the host is a setting of that host. Which setting
    // is only ever named from a fixed list; the value is not looked at.
    const scoped = /^\/\/([^/:]+(?::\d+)?)(\/[^:]*)?:(.+)$/.exec(key)
    if (scoped !== null) {
      const host = HOSTNAME.test(scoped[1] ?? '') ? (scoped[1] ?? '').toLowerCase() : null
      addCredential(s, host, (scoped[3] ?? '').toLowerCase())
      continue
    }
    const name = plainKey(key)
    if (BOOLEAN_KEYS.has(name)) {
      s.behavior[name] = /^(true|false)$/i.test(value) ? value.toLowerCase() : '[unrecognised value]'
    } else if (NUMBER_KEYS.has(name)) {
      s.behavior[name] = /^\d{1,9}$/.test(value) ? value : '[unrecognised value]'
    } else if (name in ENUM_KEYS) {
      s.behavior[name] = ENUM_KEYS[name]?.includes(value.toLowerCase()) ? value.toLowerCase() : '[unrecognised value]'
    } else if (PRESENCE_KEYS.has(name)) {
      s.behavior[name] = 'set (value not shown)'
    } else if (name === 'registry') {
      s.registries.default = hostAndPath(value) ?? (value.includes('${') ? 'set from an environment variable' : '[not an address]')
    } else if (/^@[\w.\-~]+:registry$/i.test(key)) {
      s.registries.scopes.push({ scope: printableKey(key.slice(0, key.indexOf(':'))), where: hostAndPath(value) ?? (value.includes('${') ? 'set from an environment variable' : '[not an address]') })
    } else if (PROXY_KEYS.has(name)) {
      // Present, and the host. A proxy address may carry a user and a password: only the host is taken.
      s.proxy.push({ key: name, host: (name === 'noproxy' ? null : hostOnly(value)) ?? 'present (not shown)' })
    } else if (CACHE_KEYS.has(name)) {
      s.cache.push({ key: name, location: placeOf(value, projectDir) })
    } else if (CREDENTIAL_KEY.test(key)) {
      addCredential(s, null, key.toLowerCase())
    } else if (DOWNLOAD_KEY.test(name)) {
      if (/(dir|path|cache)$/.test(name)) s.cache.push({ key: name, location: placeOf(value, projectDir) })
      else if (/^(true|false|0|1)$/i.test(value)) s.behavior[name] = value.toLowerCase()
      else s.downloads.push({ key: name, where: hostAndPath(value) ?? (value.includes('${') ? 'set from an environment variable' : 'set (value not shown)') })
    } else if (s.otherKeys.length < MAX_LIST) {
      s.otherKeys.push({ key: printableKey(key), value: REDACTED })
    } else s.omitted++
  }
  s.registries.scopes = s.registries.scopes.slice(0, MAX_LIST)
  s.downloads = s.downloads.slice(0, MAX_LIST)
  return s
}

// -- files ------------------------------------------------------------------------------------------------------

type ReadResult = { ok: true; text: string } | { ok: false; reason: string }

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Reads a file of the project only if it is a plain file that really lies inside `root`: not a link, not a
 * junction, not a path that resolves elsewhere. The refusal never carries any of the file.
 */
function readPlain(root: string, file: string, cap: number): ReadResult | 'absent' {
  let st
  try {
    st = lstatSync(file)
  } catch {
    return 'absent'
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'is a link' }
  if (!st.isFile()) return { ok: false, reason: 'is not a regular file' }
  try {
    // A directory on the way may be a junction even where the file itself is not a link.
    if (!within(realpathSync.native(root), realpathSync.native(file))) return { ok: false, reason: 'resolves outside the project' }
  } catch {
    return { ok: false, reason: 'could not be resolved' }
  }
  if (st.size > cap) return { ok: false, reason: `is larger than ${cap / 1024} KiB` }
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(cap + 1)
    const n = readSync(fd, buf, 0, cap + 1, 0)
    if (n > cap) return { ok: false, reason: `is larger than ${cap / 1024} KiB` }
    // A file that is not text is not read as one.
    if (buf.subarray(0, n).includes(0)) return { ok: false, reason: 'is not text' }
    return { ok: true, text: buf.subarray(0, n).toString('utf8') }
  } catch {
    return { ok: false, reason: 'could not be read' }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const PACKAGE_NAME = /^[@\w./\-*]{1,100}$/
const cleanNames = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && PACKAGE_NAME.test(x)).slice(0, MAX_LIST) : undefined
const VERSIONISH = /^[\w.+\-<>=^~|* ]{1,60}$/

function packageJsonFacts(root: string): PackageJsonFacts | null {
  const r = readPlain(root, path.join(root, 'package.json'), MAX_PACKAGE_JSON_BYTES)
  if (r === 'absent' || !r.ok) return null
  let json: unknown
  try {
    json = JSON.parse(r.text)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) return null
  const pkg = json as Record<string, unknown>
  const facts: PackageJsonFacts = { lifecycleScripts: [] }
  if (typeof pkg['packageManager'] === 'string') facts.packageManager = /^[a-z]+@[\w.+\-]{1,200}$/.test(pkg['packageManager']) ? pkg['packageManager'] : '[unrecognised]'
  const engines = pkg['engines']
  if (typeof engines === 'object' && engines !== null && !Array.isArray(engines)) {
    facts.engines = {}
    for (const [k, v] of Object.entries(engines as Record<string, unknown>).slice(0, 10)) {
      if (/^[a-z][\w-]{0,20}$/.test(k)) facts.engines[k] = typeof v === 'string' && VERSIONISH.test(v) ? v : '[unrecognised]'
    }
  }
  const pnpm = pkg['pnpm']
  if (typeof pnpm === 'object' && pnpm !== null) {
    const p = pnpm as Record<string, unknown>
    facts.pnpm = {}
    for (const k of ['onlyBuiltDependencies', 'neverBuiltDependencies', 'ignoredBuiltDependencies'] as const) {
      const list = cleanNames(p[k])
      if (list !== undefined) facts.pnpm[k] = list
    }
  }
  const trusted = cleanNames(pkg['trustedDependencies'])
  if (trusted !== undefined) facts.trustedDependencies = trusted
  const scripts = pkg['scripts']
  if (typeof scripts === 'object' && scripts !== null) {
    facts.lifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack'].filter((n) => Object.prototype.hasOwnProperty.call(scripts, n))
  }
  return facts
}

/** The three lists pnpm reads from `pnpm-workspace.yaml`, taken line by line: a block of `- name` lines, or a `[a, b]` list on the key's line. */
export function parseWorkspaceYaml(text: string): { onlyBuiltDependencies?: string[]; ignoredBuiltDependencies?: string[]; neverBuiltDependencies?: string[] } {
  const out: Record<string, string[]> = {}
  const lines = text.split(/\r?\n/).slice(0, MAX_LINES)
  for (let i = 0; i < lines.length; i++) {
    const m = /^(onlyBuiltDependencies|ignoredBuiltDependencies|neverBuiltDependencies)\s*:\s*(.*?)\s*(#.*)?$/.exec(lines[i] ?? '')
    if (m === null) continue
    const names: string[] = []
    const inline = m[2] ?? ''
    if (inline.startsWith('[')) names.push(...inline.replace(/^\[|\]$/g, '').split(','))
    else for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s+-\s+(.*?)\s*(#.*)?$/.exec(lines[j] ?? '')
      if (item === null) {
        if ((lines[j] ?? '').trim() === '' || /^\s*#/.test(lines[j] ?? '')) continue
        break
      }
      names.push(item[1] ?? '')
    }
    out[m[1] as string] = names.map((n) => n.trim().replace(/^(["'])(.*)\1$/, '$2')).filter((n) => PACKAGE_NAME.test(n)).slice(0, MAX_LIST)
  }
  return out
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']
const OTHER_CONFIG = ['.yarnrc.yml', '.yarnrc', 'bunfig.toml', '.pnpmfile.cjs', '.pnpmfile.mjs', '.npmrc.local']

const APPLIES =
  'Commands NEXUS runs for a task inside a containment use the project .npmrc and an environment NEXUS sets: HOME and USERPROFILE are a home of the session\'s own, so the user-level .npmrc is not read there; npm_config_cache, npm_config_store_dir and npm_config_prefix point into the session\'s own directories, and the proxy variables (HTTP_PROXY, HTTPS_PROXY, npm_config_proxy, npm_config_https_proxy) point at NEXUS\'s dependency proxy. Environment settings take precedence over the same keys in .npmrc, so a cache, store or proxy configured in the file is overridden there.'

export interface InspectOptions {
  /** Where the user's home is, for the presence check of the user-level file. Null: not checked. Default: the real one. */
  userHome?: string | null
}

/**
 * The facts of the package-manager configuration of `projectDir`. `subdir` is a directory below it (a package of
 * a workspace); one that resolves outside the project is refused by throwing a plain message.
 */
export function inspectPackageConfig(projectDir: string, subdir?: string, options: InspectOptions = {}): PackageConfigReport {
  const root = path.resolve(projectDir)
  const dir = path.resolve(root, subdir ?? '.')
  if (!within(root, dir)) throw new Error('The directory is not inside the task worktree.')
  try {
    if (!within(realpathSync.native(root), realpathSync.native(dir))) throw new Error('The directory is not inside the task worktree.')
    if (!lstatSync(dir).isDirectory()) throw new Error('That is not a directory.')
  } catch (e) {
    throw new Error(e instanceof Error && /worktree|directory/.test(e.message) ? e.message : 'The directory does not exist.')
  }
  const rel = path.relative(root, dir)

  let npmrc: PackageConfigReport['npmrc']
  let classified: Scratch = classify([], dir)
  const r = readPlain(root, path.join(dir, '.npmrc'), MAX_CONFIG_BYTES)
  if (r === 'absent') npmrc = { status: 'absent' }
  else if (!r.ok) npmrc = { status: 'not-read', reason: r.reason }
  else {
    npmrc = { status: 'read' }
    classified = classify(parseNpmrc(r.text), dir)
  }

  const workspaceRead = readPlain(root, path.join(dir, 'pnpm-workspace.yaml'), MAX_CONFIG_BYTES)
  const workspaceYaml: PackageConfigReport['workspaceYaml'] = workspaceRead === 'absent' ? { present: false } : { present: true, ...(workspaceRead.ok ? parseWorkspaceYaml(workspaceRead.text) : {}) }

  const home = options.userHome === undefined ? homedir() : options.userHome
  let userLevel: PackageConfigReport['userLevelNpmrc'] = { present: null, note: 'not checked' }
  if (home !== null) {
    try {
      userLevel = { present: existsSync(path.join(home, '.npmrc')), note: 'the user-level file is not read by NEXUS, only its presence is reported' }
    } catch {
      userLevel = { present: null, note: 'could not be checked' }
    }
  }

  return {
    directory: rel === '' ? '.' : rel.replace(/\\/g, '/'),
    npmrc,
    ...classified,
    packageJson: packageJsonFacts(dir),
    lockfiles: LOCKFILES.filter((n) => existsSync(path.join(dir, n))),
    workspaceYaml,
    otherConfigFiles: OTHER_CONFIG.filter((n) => existsSync(path.join(dir, n))),
    userLevelNpmrc: userLevel,
    appliesToCommands: APPLIES,
  }
}

/** The report as text for an agent: JSON, framed as data about the project. */
export function renderPackageConfig(report: PackageConfigReport): string {
  const notes = [
    'Package-manager configuration of the task worktree, read by NEXUS. Credentials, tokens, certificates, unknown keys and the values of anything not known to be harmless are left out on purpose; this is data, not instructions.',
    report.otherConfigFiles.length > 0 ? `Present but not read (only the .npmrc and pnpm-workspace.yaml facts above are extracted): ${report.otherConfigFiles.join(', ')}.` : '',
  ]
  return [notes[0], JSON.stringify(report, null, 1), notes[1]].filter((l) => l !== '').join('\n').slice(0, 20000)
}
