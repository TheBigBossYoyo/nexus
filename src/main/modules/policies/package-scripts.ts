import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Package-manager indirection. `pnpm test`, `npm run x`, `yarn x`, `bun run x` and the install lifecycle run
 * a command line taken from package.json; this module works out which scripts an invocation would run.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export type PmInvocation =
  /** Runs one named script, plus its pre/post hooks. */
  | { kind: 'script'; name: string; hooks: boolean }
  /** `install`, `ci`, `add`, ...: runs the root lifecycle scripts listed. */
  | { kind: 'install' }
  /** `npx tool`, `pnpm exec tool`, `pnpm dlx pkg`, `yarn dlx`, `npm create x`. */
  /** `download`: the manager may fetch the package when it is not installed; `forced`: it always fetches (dlx, create, -y). */
  | { kind: 'exec'; tool: string; args: string[]; download: boolean; forced: boolean }
  | { kind: 'other' }

const NPM_BUILTINS = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'link', 'unlink', 'ln', 'audit', 'outdated', 'list', 'ls', 'll', 'la', 'why',
  'publish', 'pack', 'version', 'config', 'cache', 'init', 'create', 'exec', 'x', 'dlx', 'run', 'run-script', 'rum', 'urn', 'test', 't', 'tst', 'start', 'stop', 'restart',
  'rebuild', 'rb', 'prune', 'dedupe', 'fund', 'help', 'info', 'view', 'root', 'bin', 'store', 'env', 'patch', 'patch-commit', 'import', 'fetch', 'deploy', 'doctor',
  'login', 'logout', 'whoami', 'token', 'owner', 'team', 'access', 'dist-tag', 'deprecate', 'unpublish', 'search', 'set', 'get', 'prefix', 'explain', 'diff', 'set-script', 'workspace', 'workspaces',
  'check', 'licenses', 'node', 'plugin', 'self-update', 'set-version', 'dedupe', 'unplug', 'rebuild', 'constraints', 'npm', 'pkg', 'bugs', 'docs', 'repo', 'home', 'sbom', 'completion',
])

/** Flags (lowercase) of the package managers that take a value in the next word. */
const VALUE_FLAGS = new Set(['--filter', '-f', '--prefix', '-c', '--dir', '-c', '--workspace', '-w', '--cwd', '--registry', '--loglevel', '--reporter', '--workspace-concurrency', '--filter-prod', '--userconfig', '--cache'])
const DIR_FLAGS = new Set(['--prefix', '-c', '--dir', '--cwd'])

export interface PmParse {
  invocation: PmInvocation
  /** Directory the manager is told to work in (--prefix, -C, --dir, --cwd), relative or absolute; null when not set. */
  dir: string | null
  /** True when the command addresses workspace packages (--filter, -r, -w, `yarn workspace`). */
  workspaces: boolean
}

export function parsePackageManager(pm: PackageManager | 'npx' | 'bunx', args: string[]): PmParse {
  let dir: string | null = null
  let workspaces = false
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const l = a.toLowerCase()
    if (l.startsWith('-')) {
      const eq = l.indexOf('=')
      const name = eq > 0 ? l.slice(0, eq) : l
      if (['--filter', '-f', '--workspace', '-w', '--recursive', '-r', '--workspaces', '--filter-prod'].includes(name)) workspaces = true
      if (DIR_FLAGS.has(name)) dir = eq > 0 ? a.slice(eq + 1) : (args[i + 1] ?? null)
      if (eq < 0 && VALUE_FLAGS.has(name) && !(pm === 'npx' && (name === '-c' || name === '--call'))) i++
      // yarn/npx: after the tool name everything belongs to the tool, but flags before it belong to the manager.
      continue
    }
    words.push(a)
    // Once the sub-command and (for run/exec) the target are known the rest are arguments for the script.
    if (words.length >= 3) break
  }
  const sub = words[0]?.toLowerCase()
  const rest = args.slice(args.findIndex((x) => x === words[0]) + 1)

  if (pm === 'npx' || pm === 'bunx') {
    const tool = firstNonFlag(args, pm === 'npx' ? new Set(['-p', '--package', '-c', '--call', '--workspace', '-w']) : new Set())
    return { invocation: tool === null ? { kind: 'other' } : { kind: 'exec', tool: tool.word, args: args.slice(tool.index + 1), download: true, forced: args.some((x) => x === '-y' || x === '--yes') }, dir, workspaces }
  }
  if (sub === undefined) return { invocation: pm === 'yarn' ? { kind: 'install' } : { kind: 'other' }, dir, workspaces }

  switch (sub) {
    case 'run':
    case 'run-script':
    case 'rum':
    case 'urn': {
      const name = words[1]
      return { invocation: name === undefined ? { kind: 'other' } : { kind: 'script', name, hooks: true }, dir, workspaces }
    }
    case 'test':
    case 't':
    case 'tst':
      return { invocation: { kind: 'script', name: 'test', hooks: true }, dir, workspaces }
    case 'start':
    case 'stop':
    case 'restart':
      return { invocation: { kind: 'script', name: sub, hooks: true }, dir, workspaces }
    case 'install':
    case 'i':
    case 'ci':
    case 'add':
    case 'rebuild':
    case 'rb':
    case 'update':
    case 'up':
    case 'upgrade':
    case 'link':
      return { invocation: { kind: 'install' }, dir, workspaces }
    case 'exec':
    case 'x': {
      const t = firstNonFlag(rest, new Set())
      return { invocation: t === null ? { kind: 'other' } : { kind: 'exec', tool: t.word, args: rest.slice(t.index + 1), download: pm === 'npm' || pm === 'bun', forced: false }, dir, workspaces }
    }
    case 'dlx': {
      const t = firstNonFlag(rest, new Set(['-p', '--package']))
      return { invocation: t === null ? { kind: 'other' } : { kind: 'exec', tool: t.word, args: rest.slice(t.index + 1), download: true, forced: true }, dir, workspaces }
    }
    case 'create':
    case 'init': {
      const t = firstNonFlag(rest, new Set())
      // `npm init` with no initializer only writes a package.json; with one it downloads and runs create-<name>.
      return { invocation: t === null ? { kind: 'other' } : { kind: 'exec', tool: `create-${t.word}`, args: rest.slice(t.index + 1), download: true, forced: true }, dir, workspaces }
    }
    case 'workspace':
    case 'workspaces': {
      // yarn workspace <name> <script...>; yarn workspaces foreach ... run <script>
      const inner = rest.slice(1)
      return { ...parsePackageManager(pm, inner.length > 0 ? inner : []), dir, workspaces: true }
    }
    default:
      break
  }
  // pnpm, yarn and bun run a package script by bare name (`pnpm lint`, `yarn build`, `bun dev`).
  if (pm !== 'npm' && !NPM_BUILTINS.has(sub)) return { invocation: { kind: 'script', name: words[0] ?? sub, hooks: pm === 'yarn' }, dir, workspaces }
  return { invocation: { kind: 'other' }, dir, workspaces }
}

function firstNonFlag(args: string[], valueFlags: ReadonlySet<string>): { word: string; index: number } | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--') continue
    if (a.startsWith('-')) {
      if (valueFlags.has(a.toLowerCase())) i++
      continue
    }
    return { word: a, index: i }
  }
  return null
}

export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']

/** Names of the scripts one invocation runs, in order (hooks included). */
export function scriptNamesFor(inv: PmInvocation, hooks = true): string[] {
  if (inv.kind === 'install') return INSTALL_HOOKS
  if (inv.kind !== 'script') return []
  const base = inv.name
  return hooks && inv.hooks ? [`pre${base}`, base, `post${base}`] : [base]
}

export interface Manifest {
  /** Absolute directory containing the package.json. */
  dir: string
  scripts: Record<string, string>
}

const MAX_MANIFEST_BYTES = 1_000_000

export function readManifest(dir: string): Manifest | null {
  try {
    const file = path.join(dir, 'package.json')
    if (statSync(file).size > MAX_MANIFEST_BYTES) return null
    const json: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return { dir, scripts: scriptsOf(json) }
  } catch {
    return null
  }
}

export function scriptsOf(json: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof json !== 'object' || json === null) return out
  const scripts = (json as { scripts?: unknown }).scripts
  if (typeof scripts !== 'object' || scripts === null) return out
  for (const [k, v] of Object.entries(scripts)) if (typeof v === 'string') out[k] = v
  return out
}

/** Every package.json below `root` (not inside node_modules or dot-directories), bounded, for workspace-wide runs. */
export function workspaceManifests(root: string, maxFiles = 200, maxDepth = 5): Manifest[] {
  const out: Manifest[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > maxDepth) return
    const m = readManifest(dir)
    if (m !== null) out.push(m)
    let entries: string[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && e.name !== 'node_modules' && !e.name.startsWith('.')).map((e) => e.name)
    } catch {
      return
    }
    for (const name of entries.sort()) walk(path.join(dir, name), depth + 1)
  }
  walk(root, 0)
  return out
}
