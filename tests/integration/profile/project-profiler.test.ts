import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { profileProject } from '@main/modules/profile/project-profiler'
import type { ProfilerGit } from '@main/modules/profile/project-profiler'

const noGit: ProfilerGit = {
  isRepository: () => Promise.resolve(false),
  repoRoot: () => Promise.reject(new Error('not a repo')),
  currentBranch: () => Promise.reject(new Error('not a repo')),
  headCommit: () => Promise.reject(new Error('not a repo')),
  status: () => Promise.reject(new Error('not a repo')),
}

const fakeGit = (dirty: boolean): ProfilerGit => ({
  isRepository: () => Promise.resolve(true),
  repoRoot: (p) => Promise.resolve(p),
  currentBranch: () => Promise.resolve('main'),
  headCommit: () => Promise.resolve('abc123'),
  status: () => Promise.resolve({ dirty }),
})

let dir: string

async function put(rel: string, content = ''): Promise<void> {
  const full = join(dir, ...rel.split('/'))
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-profile-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('profileProject: node project', () => {
  beforeEach(async () => {
    await put('pnpm-lock.yaml', 'lockfileVersion: 9')
    await put(
      'package.json',
      JSON.stringify({
        name: 'demo',
        scripts: {
          build: 'vite build',
          test: 'vitest run',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          dev: 'vite',
        },
        dependencies: { react: '^19.0.0', electron: '^44.0.0' },
        devDependencies: { vite: '^7.0.0', typescript: '^6.0.0' },
      }),
    )
    await put('tsconfig.json', '{}')
    await put('vite.config.ts', '')
    await put('src/index.ts', 'export {}')
    await put('src/App.tsx', 'export {}')
    await put('src/util.js', '')
    await put('README.md', '# demo')
    await put('CLAUDE.md', 'rules')
    await put('docs/ARCHITECTURE.md', '# arch')
    await put('docs/notes.txt', 'ignored')
    await put('node_modules/dep/index.js', 'x'.repeat(1000))
    await put('dist/out.js', 'x')
  })

  it('detects toolchain, commands, docs and generated paths', async () => {
    const p = await profileProject(dir, fakeGit(true))
    expect(p.isGitRepo).toBe(true)
    expect(p.currentBranch).toBe('main')
    expect(p.headCommit).toBe('abc123')
    expect(p.dirty).toBe(true)
    expect(p.packageManagers).toEqual(['pnpm'])
    expect(p.languages).toEqual(['TypeScript', 'JavaScript'])
    expect(p.frameworks).toEqual(expect.arrayContaining(['react', 'electron', 'vite']))
    expect(p.scripts['dev']).toBe('vite')
    expect(p.commands).toEqual({
      build: 'pnpm run build',
      test: 'pnpm test',
      lint: 'pnpm run lint',
      typecheck: 'pnpm run typecheck',
    })
    expect(p.docs).toEqual(['README.md', 'docs/ARCHITECTURE.md'])
    expect(p.hasClaudeMd).toBe(true)
    expect(p.generatedPaths.sort()).toEqual(['dist', 'node_modules'])
    expect(p.profiledAt).toMatch(/^\d{4}-/)
  })

  it('skips vendor and generated directories when counting', async () => {
    const p = await profileProject(dir, noGit)
    // package.json, lockfile, tsconfig, vite.config, 3 src files, README, CLAUDE.md, 2 docs
    expect(p.fileCount).toBe(11)
    expect(p.sizeBytes).toBeLessThan(1000)
    expect(p.isGitRepo).toBe(false)
    expect(p.currentBranch).toBeNull()
    expect(p.dirty).toBe(false)
    expect(p.repoRoot).toBe(dir)
  })
})

describe('profileProject: command inference', () => {
  it('skips the default npm placeholder test script and falls back to tsc for typescript', async () => {
    await put('package-lock.json', '{}')
    await put('tsconfig.json', '{}')
    await put(
      'package.json',
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
        devDependencies: { typescript: '^6' },
      }),
    )
    const p = await profileProject(dir, noGit)
    expect(p.packageManagers).toEqual(['npm'])
    expect(p.commands.test).toBeNull()
    expect(p.commands.build).toBeNull()
    expect(p.commands.typecheck).toBe('npx tsc --noEmit')
  })

  it('never invents a typecheck command without typescript', async () => {
    await put('package.json', JSON.stringify({ scripts: {} }))
    const p = await profileProject(dir, noGit)
    expect(p.commands).toEqual({ build: null, test: null, lint: null, typecheck: null })
  })

  it('uses yarn and bun invocation styles', async () => {
    await put('yarn.lock', '')
    await put('package.json', JSON.stringify({ scripts: { test: 'jest', build: 'tsc' } }))
    const p = await profileProject(dir, noGit)
    expect(p.commands.test).toBe('yarn test')
    expect(p.commands.build).toBe('yarn run build')
  })

  it('infers cargo and go commands', async () => {
    await put('Cargo.toml', '[package]')
    await put('Cargo.lock', '')
    await put('src/main.rs', 'fn main(){}')
    const p = await profileProject(dir, noGit)
    expect(p.packageManagers).toEqual(['cargo'])
    expect(p.languages).toEqual(['Rust'])
    expect(p.commands).toEqual({
      build: 'cargo build',
      test: 'cargo test',
      lint: 'cargo clippy',
      typecheck: 'cargo check',
    })
  })

  it('infers dotnet commands from a csproj', async () => {
    await put('App.csproj', '<Project/>')
    await put('Program.cs', '')
    const p = await profileProject(dir, noGit)
    expect(p.packageManagers).toEqual(['dotnet'])
    expect(p.commands.build).toBe('dotnet build')
    expect(p.commands.test).toBe('dotnet test')
  })
})

describe('profileProject: python project', () => {
  it('detects uv, pytest, ruff, mypy and python frameworks', async () => {
    await put('uv.lock', '')
    await put(
      'pyproject.toml',
      '[project]\nname="x"\ndependencies=["fastapi>=0.1"]\n[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n',
    )
    await put('app/main.py', 'x=1')
    await put('tests/test_main.py', 'x=1')
    await put('.venv/lib/site.py', 'ignored')
    await put('__pycache__/a.py', 'ignored')
    const p = await profileProject(dir, noGit)
    expect(p.packageManagers).toEqual(['uv'])
    expect(p.languages).toEqual(['Python'])
    expect(p.frameworks).toEqual(['fastapi'])
    expect(p.commands).toEqual({
      build: null,
      test: 'uv run pytest',
      lint: 'uv run ruff check .',
      typecheck: 'uv run mypy .',
    })
    expect(p.generatedPaths.sort()).toEqual(['.venv', '__pycache__'])
    expect(p.fileCount).toBe(4)
  })

  it('does not guess pytest for a bare requirements.txt', async () => {
    await put('requirements.txt', 'flask==3.0\n')
    await put('app.py', '')
    const p = await profileProject(dir, noGit)
    expect(p.packageManagers).toEqual(['pip'])
    expect(p.frameworks).toEqual(['flask'])
    expect(p.commands.test).toBeNull()
  })
})

describe('profileProject: robustness', () => {
  it('profiles a plain non-git folder', async () => {
    await put('notes.txt', 'hello')
    const p = await profileProject(dir, noGit)
    expect(p.isGitRepo).toBe(false)
    expect(p.fileCount).toBe(1)
    expect(p.languages).toEqual([])
    expect(p.packageManagers).toEqual([])
    expect(p.hasClaudeMd).toBe(false)
  })

  it('tolerates git calls that throw', async () => {
    const flaky: ProfilerGit = {
      ...fakeGit(false),
      currentBranch: () => Promise.reject(new Error('boom')),
      status: () => Promise.reject(new Error('boom')),
    }
    const p = await profileProject(dir, flaky)
    expect(p.isGitRepo).toBe(true)
    expect(p.currentBranch).toBeNull()
    expect(p.dirty).toBe(false)
  })

  it('tolerates malformed package.json', async () => {
    await put('package.json', '{ not json')
    const p = await profileProject(dir, noGit)
    expect(p.scripts).toEqual({})
    expect(p.commands.test).toBeNull()
  })

  it('stops at the entry cap on a large directory', async () => {
    for (let i = 0; i < 60; i++) await put(`many/f${i}.ts`, 'x')
    const capped = await profileProject(dir, noGit, { maxEntries: 20 })
    expect(capped.fileCount).toBeLessThanOrEqual(20)
    expect(capped.fileCount).toBeGreaterThan(0)
    const full = await profileProject(dir, noGit)
    expect(full.fileCount).toBe(60)
  })

  it('stops at the time cap', async () => {
    await put('a.ts', 'x')
    const p = await profileProject(dir, noGit, { maxMillis: 0 })
    expect(p.fileCount).toBe(0)
  })

  it('does not follow symlinks out of the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'nexus-outside-'))
    try {
      await writeFile(join(outside, 'secret.ts'), 'x')
      await put('real.ts', 'x')
      try {
        await symlink(outside, join(dir, 'link'), 'junction')
      } catch {
        return // symlink creation not permitted in this environment
      }
      const p = await profileProject(dir, noGit)
      expect(p.fileCount).toBe(1)
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
