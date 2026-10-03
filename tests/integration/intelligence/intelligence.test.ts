import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from '@main/modules/git/git-service'
import { analyzeRepository } from '@main/modules/intelligence/analyze'
import type { AnalyzedFact } from '@main/modules/intelligence/analyze'
import { findStaleFacts, fingerprintFiles } from '@main/modules/intelligence/fingerprint'
import { refreshIntelligence } from '@main/modules/intelligence/refresh'
import type { FactStore } from '@main/modules/intelligence/refresh'
import { profileProject } from '@main/modules/profile/project-profiler'
import type { ProfilerGit } from '@main/modules/profile/project-profiler'
import type { FactKind, RepositoryFact } from '@shared/v2'

const NOW = '2026-01-01T00:00:00.000Z'
const noGit = { isRepository: () => Promise.resolve(false), run: () => Promise.reject(new Error('no git')) }
const profilerNoGit: ProfilerGit = {
  isRepository: () => Promise.resolve(false),
  repoRoot: () => Promise.resolve(null),
  currentBranch: () => Promise.resolve(null),
  headCommit: () => Promise.resolve(null),
  status: () => Promise.resolve({ dirty: false }),
}

let dir: string

async function put(rel: string, content = ''): Promise<void> {
  const full = join(dir, ...rel.split('/'))
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

async function makeProject(): Promise<void> {
  await put(
    'package.json',
    JSON.stringify({
      name: 'demo',
      main: 'dist/index.js',
      bin: { demo: './src/cli.ts' },
      scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .' },
      dependencies: { react: '^18.2.0', zod: '^3.0.0' },
      devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
    }),
  )
  await put('pnpm-lock.yaml', '')
  await put(
    'tsconfig.json',
    '{\n // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"], }, },\n}\n',
  )
  await put(
    'eslint.config.js',
    "export default [{ rules: { 'no-restricted-imports': ['error', { patterns: ['@main/*/internal'] }] } }]\n",
  )
  await put('src/index.ts', "import { app } from './app/app'\nimport { util } from '@lib/util'\nexport { app, util }\n")
  await put('src/cli.ts', 'export {}\n')
  await put('src/app/app.ts', "import { util } from '../lib/util'\nexport const app = util\n")
  await put('src/app/app.test.ts', "import { app } from './app'\n")
  await put('src/lib/util.ts', 'export const util = 1\n')
  await put('src/lib/README.md', '# Utility helpers\n\nStuff.\n')
  await put('tests/unit/util.test.ts', "import { util } from '../../src/lib/util'\n")
  // secrets: must never be read or cited. credentials.ts would add a third importer of util if read.
  await put('.env', 'API_KEY=hunter2\n')
  await put('certs/server.pem', '-----BEGIN PRIVATE KEY-----\n')
  await put('src/id_rsa', 'PRIVATE')
  await put('src/credentials.ts', "import { util } from './lib/util'\nexport const secret = util\n")
  await put('node_modules/dep/index.js', 'module.exports = 1\n')
}

const find = (facts: AnalyzedFact[], kind: FactKind, subject: string): AnalyzedFact | undefined =>
  facts.find((f) => f.kind === kind && f.subject === subject)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-intel-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('analyzeRepository', () => {
  it('derives evidence-backed facts for a TypeScript project', async () => {
    await makeProject()
    const profile = await profileProject(dir, profilerNoGit)
    const facts = await analyzeRepository({ projectId: 'p1', rootPath: dir, profile, git: noGit, now: NOW })

    const lang = find(facts, 'language', 'TypeScript')
    expect(lang?.source).toBe('manifest')
    expect(lang?.files).toContain('package.json')

    expect(find(facts, 'framework', 'react')?.files).toContain('package.json')
    const build = find(facts, 'command', 'build')
    expect(build).toMatchObject({ source: 'manifest', confidence: 'high', files: ['package.json'] })
    expect(find(facts, 'command', 'typecheck')?.files).toEqual(expect.arrayContaining(['package.json', 'tsconfig.json']))
    expect(find(facts, 'generated_path', 'node_modules')).toBeDefined()

    const lib = find(facts, 'module', 'src/lib')
    expect(lib?.statement).toContain('mostly TypeScript')
    expect(lib?.statement).toContain('Utility helpers')
    expect(lib?.files).toContain('src/lib/README.md')
    const app = find(facts, 'module', 'src/app')
    expect(app?.statement).not.toContain('Responsibility')
    expect(find(facts, 'module', 'tests')).toBeDefined()

    expect(find(facts, 'entry_point', 'dist/index.js')?.files).toEqual(['package.json'])
    expect(find(facts, 'entry_point', 'src/cli.ts')?.files).toEqual(['package.json', 'src/cli.ts'])
    expect(find(facts, 'entry_point', 'src/index.ts')?.confidence).toBe('low')

    expect(find(facts, 'dependency', 'npm:react')?.statement).toContain('react@^18.2.0')
    expect(find(facts, 'dependency', 'npm:typescript')).toBeUndefined()

    const rel = find(facts, 'import_relation', 'src -> src/lib')
    expect(rel?.confidence).toBe('medium')
    expect(find(facts, 'import_relation', 'src/app -> src/lib')).toBeDefined()
    expect(find(facts, 'import_relation', 'tests -> src/lib')).toBeDefined()

    const hub = find(facts, 'interface', 'src/lib/util.ts')
    expect(hub?.statement).toContain('imported by 2 files')

    expect(find(facts, 'test_mapping', 'src/app/app.test.ts')).toMatchObject({
      confidence: 'low',
      files: ['src/app/app.test.ts', 'src/app/app.ts'],
    })
    expect(find(facts, 'test_mapping', 'tests/unit/util.test.ts')?.files).toContain('src/lib/util.ts')
    expect(find(facts, 'test_mapping', 'tests/')?.statement).toContain('1 test file')

    expect(find(facts, 'boundary', 'alias:@lib/*')?.statement).toContain('src/lib/*')
    expect(find(facts, 'boundary', 'eslint.config.js:no-restricted-imports')?.statement).toContain('@main/*/internal')

    for (const f of facts) {
      expect(f.projectId).toBe('p1')
      expect(f.verifiedAt).toBe(NOW)
      expect(f.fingerprint).toMatch(/^[0-9a-f]{40}$/)
      for (const file of f.files) expect(file).not.toMatch(/\\|^\.\.|^\//)
    }
  })

  it('never reads or cites secret-looking files', async () => {
    await makeProject()
    const facts = await analyzeRepository({ projectId: 'p1', rootPath: dir, profile: null, git: noGit, now: NOW })
    const cited = facts.flatMap((f) => f.files)
    for (const bad of ['.env', 'certs/server.pem', 'src/id_rsa', 'src/credentials.ts']) {
      expect(cited).not.toContain(bad)
    }
    expect(JSON.stringify(facts)).not.toMatch(/hunter2|credentials|id_rsa|server\.pem/)
    // credentials.ts imports util; had it been read util would have 3 importers.
    expect(find(facts, 'interface', 'src/lib/util.ts')?.statement).toContain('imported by 2 files')
  })

  it('works without a profile or a git repository', async () => {
    await makeProject()
    const facts = await analyzeRepository({ projectId: 'p1', rootPath: dir, profile: null, git: noGit, now: NOW })
    expect(find(facts, 'language', 'TypeScript')).toBeDefined()
    expect(find(facts, 'command', 'test')?.statement).toContain('npm run test')
    expect(facts.some((f) => f.kind === 'hot_file')).toBe(false)
  })

  it('respects the maxFiles cap', async () => {
    await put('package.json', '{}')
    for (let i = 0; i < 30; i++) await put(`src/mod${i % 3}/f${i}.ts`, 'export {}\n')
    const facts = await analyzeRepository({
      projectId: 'p1',
      rootPath: dir,
      profile: null,
      git: noGit,
      now: NOW,
      options: { maxFiles: 5 },
    })
    const counted = facts
      .filter((f) => f.kind === 'module' && f.subject !== 'src')
      .reduce((n, f) => n + Number(/: (\d+) source file/.exec(f.statement)?.[1] ?? 0), 0)
    expect(counted).toBeLessThanOrEqual(5)
  })

  it('reports hot files from a real git repository', async () => {
    const git = new GitService()
    await put('package.json', '{}')
    await put('a.ts', '1')
    await put('b.ts', '1')
    await git.run(dir, ['init', '-q'])
    await git.run(dir, ['config', 'user.email', 't@example.com'])
    await git.run(dir, ['config', 'user.name', 'T'])
    await git.run(dir, ['config', 'commit.gpgsign', 'false'])
    await git.run(dir, ['add', '-A'])
    await git.run(dir, ['commit', '-q', '-m', 'c1'])
    for (const n of ['2', '3', '4']) {
      await put('a.ts', n)
      await git.run(dir, ['add', '-A'])
      await git.run(dir, ['commit', '-q', '-m', `c${n}`])
    }
    const facts = await analyzeRepository({ projectId: 'p1', rootPath: dir, profile: null, git, now: NOW })
    const hot = facts.filter((f) => f.kind === 'hot_file')
    expect(hot.map((f) => f.subject)).toEqual(['a.ts'])
    expect(hot[0]).toMatchObject({ source: 'git', confidence: 'high', files: ['a.ts'] })
    expect(hot[0]?.statement).toContain('4 commits')
  })

  it('tolerates an empty git repository', async () => {
    const git = new GitService()
    await put('a.ts', '1')
    await git.run(dir, ['init', '-q'])
    const facts = await analyzeRepository({ projectId: 'p1', rootPath: dir, profile: null, git, now: NOW })
    expect(facts.some((f) => f.kind === 'hot_file')).toBe(false)
  })
})

describe('fingerprints', () => {
  it('changes when a supporting file changes and findStaleFacts reports it', async () => {
    await makeProject()
    const files = ['package.json', 'src/lib/util.ts']
    const before = await fingerprintFiles(dir, files)
    expect(await fingerprintFiles(dir, [...files].reverse())).toBe(before)

    const fact = { id: 'f1', files, fingerprint: before }
    expect(await findStaleFacts(dir, [fact])).toEqual([])

    await put('src/lib/util.ts', 'export const util = 2222\n')
    const future = new Date(Date.now() + 60_000)
    await utimes(join(dir, 'src/lib/util.ts'), future, future)
    expect(await fingerprintFiles(dir, files)).not.toBe(before)
    expect(await findStaleFacts(dir, [fact, { id: 'f2', files: ['package.json'], fingerprint: await fingerprintFiles(dir, ['package.json']) }])).toEqual(['f1'])
  })

  it('treats a missing file with a marker and a deleted file as a change', async () => {
    await put('x.ts', '1')
    const withFile = await fingerprintFiles(dir, ['x.ts'])
    await rm(join(dir, 'x.ts'))
    const missing = await fingerprintFiles(dir, ['x.ts'])
    expect(missing).not.toBe(withFile)
    expect(await fingerprintFiles(dir, ['../outside.ts'])).toBe(await fingerprintFiles(dir, ['../outside.ts']))
  })
})

function memoryStore(): FactStore & { rows: Map<string, RepositoryFact> } {
  const rows = new Map<string, RepositoryFact>()
  return {
    rows,
    upsert: (f) => {
      rows.set(f.id, f)
      return f
    },
    listByProject: (projectId, opts) =>
      [...rows.values()].filter(
        (f) => f.projectId === projectId && (opts?.includeStale === true || !f.stale) && (!opts?.kind || f.kind === opts.kind),
      ),
    markStale: (ids) => {
      for (const id of ids) {
        const f = rows.get(id)
        if (f) rows.set(id, { ...f, stale: true })
      }
    },
  }
}

describe('refreshIntelligence', () => {
  it('adds, updates, marks vanished facts stale and keeps agent facts', async () => {
    await makeProject()
    const store = memoryStore()
    const base = { projectId: 'p1', rootPath: dir, profile: null, git: noGit, store }

    const first = await refreshIntelligence({ ...base, now: NOW })
    expect(first.added).toBe(first.facts)
    expect(first.stale).toBe(0)
    const ids = new Map([...store.rows.values()].map((f) => [`${f.kind}:${f.subject}`, f.id]))

    // agent facts: one supported by a file that will change, one by a file that will not
    const agent = (id: string, file: string): RepositoryFact => ({
      id,
      projectId: 'p1',
      kind: 'decision',
      subject: id,
      statement: 'agent says',
      source: 'agent',
      confidence: 'medium',
      files: [file],
      fingerprint: '',
      stale: false,
      createdAt: NOW,
      verifiedAt: NOW,
    })
    const a1 = agent('a1', 'src/cli.ts')
    const a2 = agent('a2', 'src/index.ts')
    a1.fingerprint = await fingerprintFiles(dir, a1.files)
    a2.fingerprint = await fingerprintFiles(dir, a2.files)
    store.upsert(a1)
    store.upsert(a2)

    // remove a test file (its test_mapping fact vanishes); change a2's file; a1's file is removed below
    await rm(join(dir, 'src/cli.ts'))
    await rm(join(dir, 'src/app/app.test.ts'))
    await put('src/index.ts', "export const changed = true\n")
    const later = '2026-02-02T00:00:00.000Z'
    const second = await refreshIntelligence({ ...base, now: later })

    expect(second.added).toBe(0)
    expect(store.rows.get(ids.get('test_mapping:src/app/app.test.ts') ?? '')?.stale).toBe(true)
    expect(second.stale).toBeGreaterThanOrEqual(2)
    expect(store.rows.get('a1')?.stale).toBe(true)
    expect(store.rows.get('a2')?.stale).toBe(true)
    // agent facts are never deleted or rewritten by analysis
    expect(store.rows.get('a1')?.statement).toBe('agent says')
    const react = store.rows.get(ids.get('dependency:npm:react') ?? '')
    expect(react).toMatchObject({ stale: false, verifiedAt: later, createdAt: NOW })
    expect(react?.id).toBe(ids.get('dependency:npm:react'))
  })

  it('does not stale an agent fact whose files are unchanged and does not overwrite on key collision', async () => {
    await makeProject()
    const store = memoryStore()
    const fp = await fingerprintFiles(dir, ['src/lib/util.ts'])
    store.upsert({
      id: 'u1',
      projectId: 'p1',
      kind: 'module',
      subject: 'src/lib',
      statement: 'user note about lib',
      source: 'user',
      confidence: 'high',
      files: ['src/lib/util.ts'],
      fingerprint: fp,
      stale: false,
      createdAt: NOW,
      verifiedAt: NOW,
    })
    await refreshIntelligence({ projectId: 'p1', rootPath: dir, profile: null, git: noGit, store, now: NOW })
    expect(store.rows.get('u1')).toMatchObject({ statement: 'user note about lib', stale: false, source: 'user' })
    expect([...store.rows.values()].filter((f) => f.kind === 'module' && f.subject === 'src/lib')).toHaveLength(1)
  })
})
