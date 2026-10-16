import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { CheckCommands, ProjectProfile } from '@shared/domain'
import { nowIso } from '@shared/ids'
import { describeTestLayout } from './test-layout'

/** Minimal read-only git surface the profiler needs; the real GitService adapts to it. */
export interface ProfilerGit {
  isRepository(path: string): Promise<boolean>
  repoRoot(path: string): Promise<string | null>
  currentBranch(path: string): Promise<string | null>
  headCommit(path: string): Promise<string | null>
  status(path: string): Promise<{ dirty: boolean }>
  /** 0.9.1: the files git tracks (what the test layout is read from: an ignored folder of results is not the project). */
  trackedFiles?(path: string): Promise<string[] | null>
}

export interface ProfileOptions {
  /** Hard cap on files plus directories visited. */
  maxEntries?: number
  /** Hard cap on wall-clock time spent walking. */
  maxMillis?: number
}

const DEFAULT_MAX_ENTRIES = 50_000
const DEFAULT_MAX_MILLIS = 3_000
const MAX_MANIFEST_BYTES = 256 * 1024
const STAT_BATCH = 64

const GENERATED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'vendor',
  '__pycache__',
  '.next',
  'coverage',
] as const
const SKIP_DIRS: ReadonlySet<string> = new Set(GENERATED_DIRS)
/**
 * 0.9.1: an Electron application's packaged output. In Electron (NEXUS's runtime) an lstat of an `.asar` file opens
 * the archive and keeps it open: profiling NEXUS's own repository locked release\win-unpacked\resources\app.asar and
 * the owner's next installer could not be built. Neither is source.
 */
export const ASAR = /\.asar$/i
export const PACKAGED_DIR = /-unpacked$/i

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  cs: 'C#',
  java: 'Java',
  kt: 'Kotlin',
  rb: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  hpp: 'C++',
  css: 'CSS',
  scss: 'CSS',
  html: 'HTML',
  vue: 'Vue',
  svelte: 'Svelte',
  ps1: 'PowerShell',
  sh: 'Shell',
}

const NODE_FRAMEWORKS: Record<string, string> = {
  react: 'react',
  next: 'next',
  vue: 'vue',
  nuxt: 'nuxt',
  svelte: 'svelte',
  '@sveltejs/kit': 'sveltekit',
  '@angular/core': 'angular',
  electron: 'electron',
  express: 'express',
  fastify: 'fastify',
  koa: 'koa',
  '@nestjs/core': 'nestjs',
  hono: 'hono',
  vite: 'vite',
  astro: 'astro',
  tailwindcss: 'tailwind',
  vitest: 'vitest',
  jest: 'jest',
  '@playwright/test': 'playwright',
}

const CONFIG_FRAMEWORKS: [RegExp, string][] = [
  [/^next\.config\./, 'next'],
  [/^vite\.config\./, 'vite'],
  [/^svelte\.config\./, 'svelte'],
  [/^nuxt\.config\./, 'nuxt'],
  [/^astro\.config\./, 'astro'],
  [/^angular\.json$/, 'angular'],
  [/^tailwind\.config\./, 'tailwind'],
  [/^electron-builder\./, 'electron'],
  [/^electron\.vite\.config\./, 'electron'],
  [/^playwright\.config\./, 'playwright'],
  [/^vitest\.config\./, 'vitest'],
  [/^jest\.config\./, 'jest'],
  [/^manage\.py$/, 'django'],
]

const PYTHON_FRAMEWORKS = ['fastapi', 'django', 'flask'] as const

/** Reads a small regular file without following symlinks; null if absent, large, or unreadable. */
async function readSmall(path: string): Promise<string | null> {
  try {
    const st = await lstat(path)
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (v !== null && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
  }
  return out
}

interface WalkResult {
  languageCounts: Map<string, number>
  fileCount: number
  sizeBytes: number
  /** Paths relative to the root, with forward slashes; the first MAX_LISTED_FILES only. */
  files: string[]
}

const MAX_LISTED_FILES = 20_000

/** Bounded breadth-first walk. Symlinks (and junctions) are never followed or counted. */
async function walk(root: string, maxEntries: number, maxMillis: number): Promise<WalkResult> {
  const result: WalkResult = { languageCounts: new Map(), fileCount: 0, sizeBytes: 0, files: [] }
  const deadline = Date.now() + maxMillis
  const queue: string[] = [root]
  let visited = 0

  while (queue.length > 0 && visited < maxEntries && Date.now() < deadline) {
    const dir = queue.shift()
    if (dir === undefined) break
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const files: string[] = []
    for (const e of entries) {
      if (visited >= maxEntries) break
      if (e.isSymbolicLink()) continue
      visited++
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !PACKAGED_DIR.test(e.name)) queue.push(join(dir, e.name))
      } else if (e.isFile() && !ASAR.test(e.name)) {
        files.push(e.name)
      }
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const batch = files.slice(i, i + STAT_BATCH)
      const sizes = await Promise.all(
        batch.map((n) =>
          lstat(join(dir, n)).then(
            (s) => s.size,
            () => 0,
          ),
        ),
      )
      batch.forEach((name, idx) => {
        result.fileCount++
        result.sizeBytes += sizes[idx] ?? 0
        if (result.files.length < MAX_LISTED_FILES) result.files.push(relative(root, join(dir, name)).split('\\').join('/'))
        const dot = name.lastIndexOf('.')
        const lang = dot > 0 ? LANGUAGE_BY_EXT[name.slice(dot + 1).toLowerCase()] : undefined
        if (lang) result.languageCounts.set(lang, (result.languageCounts.get(lang) ?? 0) + 1)
      })
    }
  }
  return result
}

// ───────────────────────────── ecosystem detection ─────────────────────────────

const NODE_LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
]

function nodeCommands(
  pm: string,
  scripts: Record<string, string>,
  hasTsconfigAndTypescript: boolean,
): CheckCommands {
  const run = (name: string): string => {
    if (name === 'test') return `${pm} test`
    return `${pm} run ${name}`
  }
  const find = (names: string[], reject?: (body: string) => boolean): string | null => {
    for (const n of names) {
      const body = scripts[n]
      if (body === undefined || body.trim() === '') continue
      if (reject?.(body)) continue
      return run(n)
    }
    return null
  }
  const exec = pm === 'pnpm' ? 'pnpm exec' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bunx' : 'npx'
  return {
    build: find(['build']),
    // npm's generated placeholder always exits 1.
    test: find(['test'], (b) => /no test specified/i.test(b)),
    lint: find(['lint']),
    typecheck:
      find(['typecheck', 'type-check', 'check-types', 'tsc']) ??
      (hasTsconfigAndTypescript ? `${exec} tsc --noEmit` : null),
  }
}

function pythonCommands(
  rootFiles: ReadonlySet<string>,
  pyproject: string,
  requirements: string,
  pm: string | null,
): CheckCommands {
  const prefix = pm === 'uv' ? 'uv run ' : pm === 'poetry' ? 'poetry run ' : ''
  const mentions = (name: string): boolean =>
    new RegExp(`(^|[^a-z0-9_-])${name}([^a-z0-9_-]|$)`, 'im').test(pyproject + '\n' + requirements)
  const pytest =
    rootFiles.has('pytest.ini') ||
    rootFiles.has('conftest.py') ||
    /\[tool\.pytest/.test(pyproject) ||
    mentions('pytest')
  const ruff = rootFiles.has('ruff.toml') || rootFiles.has('.ruff.toml') || /\[tool\.ruff/.test(pyproject)
  const mypy = rootFiles.has('mypy.ini') || /\[tool\.mypy/.test(pyproject)
  const pyright = rootFiles.has('pyrightconfig.json') || /\[tool\.pyright/.test(pyproject)
  return {
    build: null,
    test: pytest ? `${prefix}pytest` : null,
    lint: ruff ? `${prefix}ruff check .` : null,
    typecheck: mypy ? `${prefix}mypy .` : pyright ? `${prefix}pyright` : null,
  }
}

const NO_COMMANDS: CheckCommands = { build: null, test: null, lint: null, typecheck: null }

function mergeCommands(list: CheckCommands[]): CheckCommands {
  const pick = (k: keyof CheckCommands): string | null => {
    for (const c of list) if (c[k] !== null) return c[k]
    return null
  }
  return { build: pick('build'), test: pick('test'), lint: pick('lint'), typecheck: pick('typecheck') }
}

async function listDocs(root: string, rootNames: string[]): Promise<string[]> {
  const docs = rootNames
    .filter((n) => /^(readme|contributing|architecture|design)(\.[a-z0-9]+)?$/i.test(n))
    .sort((a, b) => a.localeCompare(b))
  const nested: string[] = []
  if (rootNames.includes('docs')) {
    try {
      const entries = await readdir(join(root, 'docs'), { withFileTypes: true })
      for (const e of entries) {
        if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) nested.push(`docs/${e.name}`)
      }
    } catch {
      // unreadable docs directory: ignore
    }
  }
  return [...docs, ...nested.sort((a, b) => a.localeCompare(b))]
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Read-only discovery of a project's toolchain. Never modifies the directory. */
export async function profileProject(
  rootPath: string,
  git: ProfilerGit,
  options: ProfileOptions = {},
): Promise<ProjectProfile> {
  const root = resolve(rootPath)
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxMillis = options.maxMillis ?? DEFAULT_MAX_MILLIS

  const isGitRepo = await safe(() => git.isRepository(root), false)
  const [repoRootFromGit, currentBranch, headCommit, dirty] = isGitRepo
    ? await Promise.all([
        safe(() => git.repoRoot(root), null),
        safe(() => git.currentBranch(root), null),
        safe(() => git.headCommit(root), null),
        safe(async () => (await git.status(root)).dirty, false),
      ])
    : [null, null, null, false]

  const rootEntries = await safe(() => readdir(root, { withFileTypes: true }), [])
  const rootNames = rootEntries.map((e) => e.name)
  const rootFiles = new Set(rootEntries.filter((e) => e.isFile()).map((e) => e.name))
  const rootFilesLower = new Set([...rootFiles].map((n) => n.toLowerCase()))

  const walked = await walk(root, maxEntries, maxMillis)

  const packageManagers: string[] = []
  const addPm = (pm: string): void => {
    if (!packageManagers.includes(pm)) packageManagers.push(pm)
  }
  const frameworks = new Set<string>()
  const commandSets: CheckCommands[] = []
  let scripts: Record<string, string> = {}
  let nodeDeps: Record<string, string> = {}

  // Node
  const pkg = parseJsonObject(await readSmall(join(root, 'package.json')))
  if (pkg) {
    const declared =
      typeof pkg['packageManager'] === 'string' ? (pkg['packageManager'].split('@')[0] ?? '') : ''
    const lockPms = NODE_LOCKFILES.filter(([f]) => rootFiles.has(f)).map(([, pm]) => pm)
    for (const pm of lockPms) addPm(pm)
    if (lockPms.length === 0 && ['pnpm', 'npm', 'yarn', 'bun'].includes(declared)) addPm(declared)
    const pm = lockPms[0] ?? (['pnpm', 'npm', 'yarn', 'bun'].includes(declared) ? declared : 'npm')
    if (lockPms.length === 0 && declared === '') addPm('npm')

    scripts = stringRecord(pkg['scripts'])
    const deps = {
      ...stringRecord(pkg['dependencies']),
      ...stringRecord(pkg['devDependencies']),
      ...stringRecord(pkg['peerDependencies']),
    }
    nodeDeps = deps
    for (const [dep, fw] of Object.entries(NODE_FRAMEWORKS)) if (dep in deps) frameworks.add(fw)
    commandSets.push(nodeCommands(pm, scripts, rootFiles.has('tsconfig.json') && 'typescript' in deps))
  } else {
    for (const [f, pm] of NODE_LOCKFILES) if (rootFiles.has(f)) addPm(pm)
  }

  // Rust
  if (rootFiles.has('Cargo.toml') || rootFiles.has('Cargo.lock')) {
    addPm('cargo')
    if (rootFiles.has('Cargo.toml')) {
      commandSets.push({
        build: 'cargo build',
        test: 'cargo test',
        lint: 'cargo clippy',
        typecheck: 'cargo check',
      })
    }
  }

  // Go
  if (rootFiles.has('go.mod') || rootFiles.has('go.sum')) {
    addPm('go')
    if (rootFiles.has('go.mod')) {
      commandSets.push({ build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...', typecheck: null })
    }
  }

  // Python
  const pyproject = (await readSmall(join(root, 'pyproject.toml'))) ?? ''
  const requirements = (await readSmall(join(root, 'requirements.txt'))) ?? ''
  const hasPython =
    rootFiles.has('pyproject.toml') ||
    rootFiles.has('requirements.txt') ||
    rootFiles.has('poetry.lock') ||
    rootFiles.has('uv.lock')
  if (hasPython) {
    let pyPm: string | null = null
    if (rootFiles.has('uv.lock')) pyPm = 'uv'
    else if (rootFiles.has('poetry.lock') || /\[tool\.poetry\]/.test(pyproject)) pyPm = 'poetry'
    if (rootFiles.has('poetry.lock')) addPm('poetry')
    if (rootFiles.has('uv.lock')) addPm('uv')
    if (rootFiles.has('requirements.txt')) addPm('pip')
    commandSets.push(pythonCommands(rootFiles, pyproject, requirements, pyPm))
    const text = (pyproject + '\n' + requirements).toLowerCase()
    for (const fw of PYTHON_FRAMEWORKS) {
      if (new RegExp(`(^|[^a-z0-9_-])${fw}([^a-z0-9_-]|$)`, 'm').test(text)) frameworks.add(fw)
    }
  }

  // .NET
  const dotnetProject = rootNames.find((n) => /\.(sln|slnx|csproj|fsproj)$/i.test(n))
  if (dotnetProject) {
    addPm('dotnet')
    commandSets.push({ build: 'dotnet build', test: 'dotnet test', lint: null, typecheck: null })
  }

  // JVM
  if (rootFiles.has('pom.xml')) {
    addPm('maven')
    commandSets.push({ build: 'mvn -B compile', test: 'mvn -B test', lint: null, typecheck: null })
  }
  if (rootFiles.has('build.gradle') || rootFiles.has('build.gradle.kts')) {
    addPm('gradle')
    const g = rootFiles.has('gradlew.bat') ? 'gradlew.bat' : 'gradle'
    commandSets.push({ build: `${g} build`, test: `${g} test`, lint: null, typecheck: null })
  }

  for (const name of rootNames) {
    for (const [re, fw] of CONFIG_FRAMEWORKS) if (re.test(name)) frameworks.add(fw)
  }

  const runnerConfigs: { name: string; text: string }[] = []
  for (const name of rootNames.filter((n) => /^(vitest|vite|jest)\.config\.[cm]?[jt]s$/.test(n)).sort()) {
    const text = await readSmall(join(root, name))
    if (text !== null) runnerConfigs.push({ name, text })
  }
  const tracked = isGitRepo && git.trackedFiles ? await safe(() => git.trackedFiles?.(root) ?? Promise.resolve(null), null) : null
  const testLayout = describeTestLayout({ files: tracked ?? walked.files, deps: nodeDeps, runnerConfigs })

  const languages = [...walked.languageCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l]) => l)

  return {
    repoRoot: repoRootFromGit ?? root,
    isGitRepo,
    currentBranch,
    headCommit,
    dirty,
    packageManagers,
    languages,
    frameworks: [...frameworks].sort(),
    scripts,
    commands: mergeCommands(commandSets.length > 0 ? commandSets : [NO_COMMANDS]),
    docs: await listDocs(root, rootNames),
    hasClaudeMd: rootFilesLower.has('claude.md'),
    fileCount: walked.fileCount,
    sizeBytes: walked.sizeBytes,
    generatedPaths: GENERATED_DIRS.filter(
      (d) => d !== '.git' && rootEntries.some((e) => e.name === d && e.isDirectory()),
    ),
    ...(testLayout.length > 0 ? { testLayout } : {}),
    profiledAt: nowIso(),
  }
}
