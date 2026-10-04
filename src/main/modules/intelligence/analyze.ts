import { readdir } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import type { GitService } from '@main/modules/git/git-service'
import type { ProjectProfile } from '@shared/domain'
import type { FactKind, FactSource, RepositoryFact } from '@shared/v2'
import { fingerprintFiles } from './fingerprint'
import type { StatCache } from './fingerprint'
import {
  LANGUAGE_BY_EXT,
  baseName,
  dirName,
  extOf,
  extractImports,
  familyOf,
  parseCargoDependencies,
  parseGoMod,
  parseJsonLoose,
  parseJsonObject,
  parsePyprojectDependencies,
  stringLeaves,
  stringRecord,
} from './parsers'
import type { DepSpec } from './parsers'
import { SKIP_DIRS, isSecretPath, readBounded, walkRepository } from './walk'

export type AnalyzedFact = Omit<RepositoryFact, 'id' | 'createdAt' | 'stale'>

export interface AnalyzeInput {
  projectId: string
  rootPath: string
  profile: ProjectProfile | null
  git: Pick<GitService, 'isRepository' | 'run'>
  now: string
  options?: { maxFiles?: number; maxMillis?: number; maxFileBytes?: number }
}

const DEFAULT_MAX_FILES = 4000
const DEFAULT_MAX_MILLIS = 5000
const DEFAULT_MAX_FILE_BYTES = 200_000
/** Supporting files recorded per fact. */
const FACT_FILES_CAP = 12
const MAX_DEPENDENCIES = 30
const MAX_RELATIONS = 80
const MAX_FAN_IN = 15
const MAX_TEST_FACTS = 200
const MAX_HOT_FILES = 15
const GIT_HISTORY_COMMITS = 200
const JS_EXTS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'] as const
const TEST_DIR_NAMES: ReadonlySet<string> = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e'])
const ROOT_MANIFESTS = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
] as const

interface Draft {
  kind: FactKind
  subject: string
  statement: string
  source: FactSource
  confidence: 'low' | 'medium' | 'high'
  files: string[]
}

interface TsAlias {
  pattern: string
  targets: string[]
  file: string
}

export function moduleOf(path: string): string {
  const s = path.split('/')
  if (s.length < 2) return '.'
  const a = s[0] ?? ''
  if ((a === 'src' || a === 'packages' || a === 'apps') && s.length >= 3) return `${a}/${s[1] ?? ''}`
  return a
}

export function isTestFile(path: string): boolean {
  const name = baseName(path)
  if (/\.(test|spec)\.[a-z]+$/i.test(name)) return true
  if (/^test_.+\.py$|_test\.(py|go)$/.test(name)) return true
  return dirName(path)
    .split('/')
    .some((seg) => TEST_DIR_NAMES.has(seg))
}

const trim = (s: string, max = 160): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Bounded, read-only repository analysis. Reads file names, sizes, manifests and a bounded prefix of
 * source files for import statements. Never reads secret-looking files and never follows links.
 */
export async function analyzeRepository(input: AnalyzeInput): Promise<AnalyzedFact[]> {
  const root = resolve(input.rootPath)
  const maxFiles = Math.max(1, input.options?.maxFiles ?? DEFAULT_MAX_FILES)
  const maxMillis = input.options?.maxMillis ?? DEFAULT_MAX_MILLIS
  const maxFileBytes = Math.max(1, input.options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
  const deadline = Date.now() + maxMillis

  const walk = await walkRepository(root, maxFiles, deadline)
  const files = walk.files
  const paths = new Set(files.map((f) => f.path))
  const rootFiles = files.filter((f) => !f.path.includes('/')).map((f) => f.path)
  const read = (rel: string, cap = maxFileBytes): Promise<string | null> => readBounded(root, rel, cap)

  const drafts = new Map<string, Draft>()
  const add = (d: Draft): void => {
    const key = `${d.kind}\0${d.subject}`
    if (drafts.has(key)) return
    const evidence = [...new Set(d.files.filter((f) => !isSecretPath(f)))]
    drafts.set(key, { ...d, files: evidence.slice(0, FACT_FILES_CAP) })
  }
  const present = (names: readonly string[]): string[] => names.filter((n) => paths.has(n))

  const pkg = paths.has('package.json') ? parseJsonObject(await read('package.json')) : null

  // ───────────── languages ─────────────
  const langCounts = new Map<string, number>()
  for (const f of files) {
    const lang = LANGUAGE_BY_EXT[extOf(f.path)]
    if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1)
  }
  const languages =
    input.profile?.languages ??
    [...langCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l)
  const manifestEvidence = present(ROOT_MANIFESTS)
  for (const lang of languages.slice(0, 8)) {
    const n = langCounts.get(lang) ?? 0
    add({
      kind: 'language',
      subject: lang,
      statement: n > 0 ? `${lang}: ${plural(n, 'file')} in the analyzed tree` : `${lang} is used (per project profile)`,
      source: 'manifest',
      confidence: 'high',
      files: manifestEvidence,
    })
  }

  // ───────────── frameworks ─────────────
  const frameworks =
    input.profile?.frameworks ??
    (pkg
      ? Object.keys({ ...stringRecord(pkg['dependencies']), ...stringRecord(pkg['devDependencies']) }).filter((d) =>
          ['react', 'next', 'vue', 'svelte', 'electron', 'express', 'fastify', 'vite', 'vitest', 'jest'].includes(d),
        )
      : [])
  for (const fw of frameworks) {
    const configs = rootFiles.filter((n) => n.toLowerCase().includes(fw.toLowerCase()) && /config|\.json$/i.test(n))
    add({
      kind: 'framework',
      subject: fw,
      statement: `Project uses ${fw}`,
      source: 'manifest',
      confidence: 'high',
      files: [...present(['package.json', 'pyproject.toml', 'requirements.txt']), ...configs],
    })
  }

  // ───────────── commands ─────────────
  const commands: Record<'build' | 'test' | 'lint' | 'typecheck', string | null> = input.profile?.commands ?? {
    build: null,
    test: null,
    lint: null,
    typecheck: null,
  }
  if (!input.profile && pkg) {
    const scripts = stringRecord(pkg['scripts'])
    for (const k of ['build', 'test', 'lint', 'typecheck'] as const) if (scripts[k]) commands[k] = `npm run ${k}`
  }
  const evidenceForCommand = (cmd: string, kind: string): string[] => {
    if (/^(pnpm|npm|yarn|bun|bunx|npx)\b/.test(cmd)) {
      return present(kind === 'typecheck' ? ['package.json', 'tsconfig.json'] : ['package.json'])
    }
    if (/^cargo\b/.test(cmd)) return present(['Cargo.toml'])
    if (/^go\b/.test(cmd)) return present(['go.mod'])
    if (/^dotnet\b/.test(cmd)) return rootFiles.filter((n) => /\.(sln|slnx|csproj|fsproj)$/i.test(n)).slice(0, 2)
    if (/^mvn\b/.test(cmd)) return present(['pom.xml'])
    if (/^(gradle|gradlew)/.test(cmd)) return present(['build.gradle', 'build.gradle.kts'])
    return present(['pyproject.toml', 'pytest.ini', 'ruff.toml', 'mypy.ini', 'requirements.txt'])
  }
  for (const k of ['build', 'test', 'lint', 'typecheck'] as const) {
    const cmd = commands[k]
    if (cmd) {
      add({
        kind: 'command',
        subject: k,
        statement: `${k}: ${cmd}`,
        source: 'manifest',
        confidence: 'high',
        files: evidenceForCommand(cmd, k),
      })
    }
  }

  // ───────────── generated paths ─────────────
  let generated: string[] = input.profile ? [...input.profile.generatedPaths] : []
  if (!input.profile) {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      generated = entries
        .filter((e) => e.isDirectory() && !e.isSymbolicLink() && SKIP_DIRS.has(e.name) && e.name !== '.git')
        .map((e) => e.name)
        .sort()
    } catch {
      generated = []
    }
  }
  for (const g of generated) {
    add({
      kind: 'generated_path',
      subject: g,
      statement: `${g}/ is generated or vendored output; exclude it from edits and analysis`,
      source: 'manifest',
      confidence: 'high',
      files: [],
    })
  }

  // ───────────── modules ─────────────
  interface ModuleStat {
    count: number
    langs: Map<string, number>
    samples: string[]
  }
  const modules = new Map<string, ModuleStat>()
  const bump = (key: string, file: string, lang: string): void => {
    let m = modules.get(key)
    if (!m) {
      m = { count: 0, langs: new Map(), samples: [] }
      modules.set(key, m)
    }
    m.count++
    m.langs.set(lang, (m.langs.get(lang) ?? 0) + 1)
    if (m.samples.length < 6) m.samples.push(file)
  }
  for (const f of files) {
    const lang = LANGUAGE_BY_EXT[extOf(f.path)]
    if (!lang || !f.path.includes('/')) continue
    const key = moduleOf(f.path)
    bump(key, f.path, lang)
    const top = f.path.slice(0, f.path.indexOf('/'))
    if (top !== key) bump(top, f.path, lang)
  }
  for (const key of [...modules.keys()].sort().slice(0, 80)) {
    const m = modules.get(key)
    if (!m) continue
    const [lang, langN] = [...m.langs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ['', 0]
    let statement = `${key}: ${plural(m.count, 'source file')}, mostly ${lang} (${Math.round((langN / m.count) * 100)}%).`
    const evidence = [...m.samples]
    const readme = ['README.md', 'readme.md', 'Readme.md'].map((n) => `${key}/${n}`).find((p) => paths.has(p))
    let responsibility: string | null = null
    if (readme) {
      const heading = /^#\s+(.+)$/m.exec((await read(readme, 8192)) ?? '')?.[1]
      if (heading) {
        responsibility = `Responsibility (from ${readme} heading): ${trim(heading, 120)}`
        evidence.unshift(readme)
      }
    }
    if (!responsibility && paths.has(`${key}/package.json`)) {
      const desc = parseJsonObject(await read(`${key}/package.json`, 32_768))?.['description']
      if (typeof desc === 'string' && desc.trim() !== '') {
        responsibility = `Responsibility (from ${key}/package.json description): ${trim(desc, 120)}`
        evidence.unshift(`${key}/package.json`)
      }
    }
    if (responsibility) statement += ` ${responsibility}`
    add({ kind: 'module', subject: key, statement, source: 'static_analysis', confidence: 'medium', files: evidence })
  }

  // ───────────── entry points ─────────────
  if (pkg) {
    for (const field of ['main', 'module', 'bin', 'exports'] as const) {
      for (const leaf of stringLeaves(pkg[field])) {
        const target = posix.normalize(leaf.replace(/^\.\//, ''))
        if (target.includes('*') || target.startsWith('..')) continue
        add({
          kind: 'entry_point',
          subject: target,
          statement: `package.json "${field}" points to ${target}`,
          source: 'manifest',
          confidence: 'high',
          files: ['package.json', ...(paths.has(target) ? [target] : [])],
        })
      }
    }
  }
  const ENTRY_PATTERNS: RegExp[] = [
    /^src\/(index|main|app|cli|server)\.(ts|tsx|js|jsx|mjs|cjs|mts)$/,
    /^(index|main|app|server)\.(ts|js|mjs|cjs)$/,
    /^src\/(main|renderer|preload)\/index\.(ts|tsx|js|mjs)$/,
    /^(packages|apps)\/[^/]+\/src\/(index|main)\.(ts|tsx|js|mjs)$/,
    /^(src\/)?(main|__main__)\.py$|^(app|manage)\.py$/,
    /^cmd\/[^/]+\/main\.go$|^main\.go$/,
    /^src\/(main|lib)\.rs$|^src\/bin\/[^/]+\.rs$/,
  ]
  let entries = 0
  for (const f of files) {
    if (entries >= 40) break
    if (ENTRY_PATTERNS.some((re) => re.test(f.path))) {
      entries++
      add({
        kind: 'entry_point',
        subject: f.path,
        statement: `${f.path} is a conventional entry file`,
        source: 'static_analysis',
        confidence: 'low',
        files: [f.path],
      })
    }
  }

  // ───────────── dependencies ─────────────
  const addDeps = (eco: string, manifest: string, deps: DepSpec[]): void => {
    for (const d of [...deps].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_DEPENDENCIES)) {
      add({
        kind: 'dependency',
        subject: `${eco}:${d.name}`,
        statement: `Runtime dependency ${d.name}@${d.spec} (${manifest})`,
        source: 'manifest',
        confidence: 'high',
        files: [manifest],
      })
    }
  }
  if (pkg) {
    addDeps(
      'npm',
      'package.json',
      Object.entries(stringRecord(pkg['dependencies'])).map(([name, spec]) => ({ name, spec })),
    )
  }
  if (paths.has('pyproject.toml')) addDeps('pypi', 'pyproject.toml', parsePyprojectDependencies((await read('pyproject.toml')) ?? ''))
  if (paths.has('Cargo.toml')) addDeps('cargo', 'Cargo.toml', parseCargoDependencies((await read('Cargo.toml')) ?? ''))
  let goModule: string | null = null
  if (paths.has('go.mod')) {
    const gm = parseGoMod((await read('go.mod')) ?? '')
    goModule = gm.module
    addDeps('go', 'go.mod', gm.deps)
  }

  // ───────────── boundaries ─────────────
  const aliases: TsAlias[] = []
  for (const name of rootFiles.filter((n) => /^tsconfig(\..+)?\.json$/.test(n)).sort()) {
    const ts = parseJsonLoose(await read(name, 65_536))
    const co = ts?.['compilerOptions']
    if (co === null || typeof co !== 'object') continue
    const opts = co as Record<string, unknown>
    const baseUrl = typeof opts['baseUrl'] === 'string' ? opts['baseUrl'] : '.'
    const pathsOpt = opts['paths']
    if (pathsOpt === null || typeof pathsOpt !== 'object') continue
    for (const [pattern, targets] of Object.entries(pathsOpt)) {
      if (!Array.isArray(targets) || aliases.some((a) => a.pattern === pattern)) continue
      const resolved = targets
        .filter((t): t is string => typeof t === 'string')
        .map((t) => posix.normalize(posix.join(baseUrl, t)).replace(/^\.\//, '').replace(/^\.$/, ''))
      if (resolved.length === 0) continue
      aliases.push({ pattern, targets: resolved, file: name })
      add({
        kind: 'boundary',
        subject: `alias:${pattern}`,
        statement: `${name} path alias ${pattern} maps to ${resolved.join(', ')}`,
        source: 'manifest',
        confidence: 'high',
        files: [name],
      })
    }
  }
  const eslintFiles = rootFiles.filter((n) => /^(\.eslintrc(\..+)?|eslint\.config\.[mc]?[jt]s)$/.test(n)).sort()
  for (const name of eslintFiles) {
    const text = (await read(name, 65_536)) ?? ''
    for (const rule of ['no-restricted-imports', 'no-restricted-paths', 'boundaries/element-types'] as const) {
      const at = text.indexOf(rule)
      if (at < 0) continue
      const patterns = [...text.slice(at + rule.length + 1, at + 800).matchAll(/['"]([^'"\n]{2,80})['"]/g)]
        .map((m) => m[1] ?? '')
        .filter((s) => s !== rule && /[/*]|^@/.test(s))
      const unique = [...new Set(patterns)].slice(0, 8)
      add({
        kind: 'boundary',
        subject: `${name}:${rule}`,
        statement:
          `${name} configures ${rule}` + (unique.length > 0 ? `; patterns mentioned: ${unique.join(', ')}` : ''),
        source: 'manifest',
        confidence: 'high',
        files: [name],
      })
    }
  }
  const workspaceGlobs: { glob: string; file: string }[] = []
  const pkgWs = pkg?.['workspaces']
  const wsList = Array.isArray(pkgWs) ? pkgWs : pkgWs !== null && typeof pkgWs === 'object' ? (pkgWs as Record<string, unknown>)['packages'] : null
  if (Array.isArray(wsList)) for (const g of wsList) if (typeof g === 'string') workspaceGlobs.push({ glob: g, file: 'package.json' })
  if (paths.has('pnpm-workspace.yaml')) {
    const yaml = (await read('pnpm-workspace.yaml', 16_384)) ?? ''
    const block = /^packages:\s*\n((?:[ \t]*-[^\n]*\n?)+)/m.exec(yaml)?.[1] ?? ''
    for (const m of block.matchAll(/-\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/gm)) {
      if (m[1]) workspaceGlobs.push({ glob: m[1], file: 'pnpm-workspace.yaml' })
    }
  }
  for (const w of workspaceGlobs.slice(0, 20)) {
    add({
      kind: 'boundary',
      subject: `workspace:${w.glob}`,
      statement: `${w.file} declares workspace packages matching ${w.glob}; each is a package boundary`,
      source: 'manifest',
      confidence: 'high',
      files: [w.file],
    })
  }

  // ───────────── imports ─────────────
  const codeFiles = files.filter((f) => familyOf(f.path) !== null)
  const goDirs = new Map<string, string>()
  for (const f of codeFiles) {
    if (extOf(f.path) === 'go' && !f.path.endsWith('_test.go') && !goDirs.has(dirName(f.path))) goDirs.set(dirName(f.path), f.path)
  }
  const tryJs = (base: string): string | null => {
    const n = base === '.' ? '' : base
    const stem = n.replace(/\.(?:m|c)?jsx?$/, '')
    const cands: string[] = [n]
    if (stem !== n) for (const e of JS_EXTS) cands.push(`${stem}.${e}`)
    for (const e of JS_EXTS) cands.push(`${n}.${e}`)
    for (const e of JS_EXTS) cands.push(n === '' ? `index.${e}` : `${n}/index.${e}`)
    return cands.find((c) => c !== '' && paths.has(c) && familyOf(c) === 'js') ?? null
  }
  const resolveImport = (from: string, spec: string): string | null => {
    const family = familyOf(from)
    if (family === 'js') {
      const bases: string[] = []
      if (spec.startsWith('.')) bases.push(posix.join(dirName(from), spec))
      else {
        for (const a of aliases) {
          if (a.pattern.endsWith('*')) {
            const prefix = a.pattern.slice(0, -1)
            if (spec.startsWith(prefix)) for (const t of a.targets) bases.push(t.replace('*', spec.slice(prefix.length)))
          } else if (spec === a.pattern) bases.push(...a.targets)
        }
      }
      for (const b of bases) {
        const n = posix.normalize(b)
        if (n.startsWith('..')) continue
        const hit = tryJs(n)
        if (hit) return hit
      }
      return null
    }
    if (family === 'py') {
      const dots = /^\.*/.exec(spec)?.[0].length ?? 0
      const parts = spec.slice(dots).split('.').filter(Boolean)
      const roots: string[] = []
      if (dots > 0) {
        let base = dirName(from)
        for (let i = 1; i < dots; i++) base = dirName(base)
        roots.push(base)
      } else roots.push('', 'src')
      for (const r of roots) {
        for (let take = parts.length; take >= (dots > 0 ? 0 : 1); take--) {
          const p = posix.join(r, ...parts.slice(0, take))
          const cands = take === 0 ? [posix.join(r, '__init__.py')] : [`${p}.py`, `${p}/__init__.py`]
          const hit = cands.find((c) => paths.has(c))
          if (hit) return hit
          if (dots > 0 && take === parts.length) continue
        }
      }
      return null
    }
    if (family === 'go') {
      if (goModule === null || !(spec === goModule || spec.startsWith(`${goModule}/`))) return null
      return goDirs.get(spec === goModule ? '' : spec.slice(goModule.length + 1)) ?? null
    }
    // Rust
    const idx = spec.indexOf(':')
    const kind = spec.slice(0, idx)
    const name = spec.slice(idx + 1)
    let baseDir: string | null
    if (kind === 'mod') {
      const file = baseName(from)
      baseDir = ['mod.rs', 'lib.rs', 'main.rs'].includes(file) ? dirName(from) : posix.join(dirName(from), file.replace(/\.rs$/, ''))
    } else {
      baseDir = from.startsWith('src/') ? 'src' : from.includes('/src/') ? `${from.slice(0, from.indexOf('/src/'))}/src` : null
    }
    if (baseDir === null) return null
    return [`${baseDir}/${name}.rs`, `${baseDir}/${name}/mod.rs`].map((c) => c.replace(/^\//, '')).find((c) => paths.has(c)) ?? null
  }

  const relations = new Map<string, { from: string; to: string; pairs: number; importers: Set<string>; targets: Set<string> }>()
  const fanIn = new Map<string, Set<string>>()
  for (let i = 0; i < codeFiles.length; i += 32) {
    if (Date.now() >= deadline) break
    const batch = codeFiles.slice(i, i + 32)
    const texts = await Promise.all(batch.map((f) => read(f.path)))
    batch.forEach((f, idx) => {
      const text = texts[idx]
      const family = familyOf(f.path)
      // The deadline is checked per file: one hostile file must not hold a whole batch past it.
      if (text === null || text === undefined || family === null || Date.now() >= deadline) return
      const targets = new Set<string>()
      for (const spec of extractImports(family, text)) {
        const t = resolveImport(f.path, spec)
        if (t !== null && t !== f.path) targets.add(t)
      }
      const fromMod = moduleOf(f.path)
      for (const t of targets) {
        if (!isTestFile(f.path)) {
          let s = fanIn.get(t)
          if (!s) fanIn.set(t, (s = new Set()))
          s.add(f.path)
        }
        const toMod = moduleOf(t)
        if (fromMod === '.' || toMod === '.' || fromMod === toMod) continue
        const key = `${fromMod}\0${toMod}`
        let r = relations.get(key)
        if (!r) relations.set(key, (r = { from: fromMod, to: toMod, pairs: 0, importers: new Set(), targets: new Set() }))
        r.pairs++
        r.importers.add(f.path)
        r.targets.add(t)
      }
    })
  }
  const topRelations = [...relations.values()]
    .sort((a, b) => b.pairs - a.pairs || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, MAX_RELATIONS)
  for (const r of topRelations) {
    add({
      kind: 'import_relation',
      subject: `${r.from} -> ${r.to}`,
      statement: `${r.from} imports from ${r.to}: ${plural(r.pairs, 'import')} across ${plural(r.importers.size, 'file')}`,
      source: 'static_analysis',
      confidence: 'medium',
      files: [...[...r.importers].sort().slice(0, 3), ...[...r.targets].sort().slice(0, 3)],
    })
  }
  const topFanIn = [...fanIn.entries()]
    .filter(([t, s]) => s.size >= 2 && familyOf(t) !== null)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, MAX_FAN_IN)
  for (const [target, importers] of topFanIn) {
    add({
      kind: 'interface',
      subject: target,
      statement: `${target} is imported by ${plural(importers.size, 'file')}; changes here ripple widely`,
      source: 'static_analysis',
      confidence: 'medium',
      files: [target],
    })
  }

  // ───────────── test mapping ─────────────
  const stemIndex = new Map<string, string[]>()
  for (const f of codeFiles) {
    if (isTestFile(f.path)) continue
    const key = `${familyOf(f.path) ?? ''}:${baseName(f.path).replace(/\.[^.]+$/, '')}`
    const list = stemIndex.get(key)
    if (list) list.push(f.path)
    else stemIndex.set(key, [f.path])
  }
  const testStem = (path: string): string | null => {
    const name = baseName(path)
    return (
      /^(.+)\.(?:test|spec)\.[a-z]+$/i.exec(name)?.[1] ??
      /^test_(.+)\.py$/.exec(name)?.[1] ??
      /^(.+)_test\.(?:py|go)$/.exec(name)?.[1] ??
      (extOf(path) === 'rs' && /(^|\/)tests\//.test(path) ? name.replace(/\.rs$/, '') : null)
    )
  }
  const trailingOverlap = (a: string, b: string): number => {
    const x = dirName(a).split('/').filter((s) => !TEST_DIR_NAMES.has(s))
    const y = dirName(b).split('/').filter((s) => !TEST_DIR_NAMES.has(s))
    let n = 0
    while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++
    return n
  }
  let testFacts = 0
  const testDirs = new Map<string, string[]>()
  for (const f of codeFiles) {
    if (!isTestFile(f.path)) continue
    const segs = dirName(f.path).split('/')
    const at = segs.findIndex((s) => TEST_DIR_NAMES.has(s))
    if (at >= 0) {
      const dir = segs.slice(0, at + 1).join('/')
      const list = testDirs.get(dir)
      if (list) list.push(f.path)
      else testDirs.set(dir, [f.path])
    }
    const stem = testStem(f.path)
    const family = familyOf(f.path)
    if (stem === null || family === null || testFacts >= MAX_TEST_FACTS) continue
    const cands = stemIndex.get(`${family}:${stem}`) ?? []
    const sameDir = cands.filter((c) => dirName(c) === dirName(f.path))
    let pick: string | undefined
    if (sameDir.length > 0) pick = sameDir[0]
    else if (cands.length > 0 && cands.length <= 3) {
      pick = [...cands].sort((a, b) => trailingOverlap(f.path, b) - trailingOverlap(f.path, a) || a.length - b.length || a.localeCompare(b))[0]
    }
    if (pick === undefined) continue
    testFacts++
    add({
      kind: 'test_mapping',
      subject: f.path,
      statement: `${f.path} appears to test ${pick} (matched by naming convention)`,
      source: 'static_analysis',
      confidence: 'low',
      files: [f.path, pick],
    })
  }
  for (const [dir, list] of [...testDirs.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 20)) {
    add({
      kind: 'test_mapping',
      subject: `${dir}/`,
      statement: `${dir}/ holds ${plural(list.length, 'test file')}`,
      source: 'static_analysis',
      confidence: 'low',
      files: list.slice(0, 6),
    })
  }

  // ───────────── git hot files ─────────────
  if (Date.now() < deadline) {
    try {
      if (await input.git.isRepository(root)) {
        const r = await input.git.run(
          root,
          ['log', '-n', String(GIT_HISTORY_COMMITS), '--name-only', '--format=', '--relative'],
          { okCodes: [0, 128], maxOutputBytes: 4 * 1024 * 1024, keep: 'head', timeoutMs: Math.max(1000, deadline - Date.now()) },
        )
        if (r.exitCode === 0) {
          const counts = new Map<string, number>()
          for (const line of r.stdout.split(/\r?\n/)) {
            const p = line.trim().replace(/\\/g, '/')
            if (p !== '' && paths.has(p) && !isSecretPath(p)) counts.set(p, (counts.get(p) ?? 0) + 1)
          }
          const hot = [...counts.entries()]
            .filter(([, n]) => n >= 2)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, MAX_HOT_FILES)
          for (const [p, n] of hot) {
            add({
              kind: 'hot_file',
              subject: p,
              statement: `${p} changed in ${plural(n, 'commit')} within the last ${GIT_HISTORY_COMMITS} commits`,
              source: 'git',
              confidence: 'high',
              files: [p],
            })
          }
        }
      }
    } catch {
      // not a repository, git missing, or empty history: no hot files
    }
  }

  // ───────────── fingerprints ─────────────
  const cache: StatCache = new Map()
  const out: AnalyzedFact[] = []
  const ordered = [...drafts.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject),
  )
  for (let i = 0; i < ordered.length; i += 64) {
    const batch = ordered.slice(i, i + 64)
    const prints = await Promise.all(batch.map((d) => fingerprintFiles(root, d.files, cache)))
    batch.forEach((d, idx) => {
      out.push({
        projectId: input.projectId,
        kind: d.kind,
        subject: d.subject,
        statement: d.statement,
        source: d.source,
        confidence: d.confidence,
        files: d.files,
        fingerprint: prints[idx] ?? '',
        verifiedAt: input.now,
      })
    })
  }
  return out
}
