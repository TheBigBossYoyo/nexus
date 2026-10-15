import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failedTestFiles, rerunTestsCommand, scopeFinalChecks, scopeTaskChecks, scriptOf, testsNaming } from '@main/modules/orchestrator/check-scope'

// 0.9.1: a task's checks are about its own changes. Found when a mission on NEXUS itself ran the whole 15-minute
// suite after a task, timed out, and sent a repair agent to fix code that had nothing wrong with it.

const dir = resolve('test-results', 'check-scope')
const ORDER = ['typecheck', 'lint', 'build', 'test'] as const
const checks = { typecheck: 'pnpm typecheck', lint: 'pnpm lint', build: 'pnpm build', test: 'pnpm test' }

function project(scripts: Record<string, string>, files: string[]): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'src', 'a b'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }))
  for (const f of files) writeFileSync(join(dir, f), 'export {}\n')
}

describe('scopeTaskChecks', () => {
  beforeAll(() => mkdirSync(dir, { recursive: true }))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('runs the related vitest tests and the linter on the changed files, the type check whole, and no build', () => {
    project({ test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build' }, ['src/panel.tsx', 'src/a b/model.ts'])
    mkdirSync(join(dir, 'tests'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'panel.test.ts'), "import { x } from '../src/panel'\n")
    writeFileSync(join(dir, 'tests', 'other.test.ts'), "import { y } from '../src/unrelated'\n")
    const out = scopeTaskChecks({ checks, order: ORDER, cwd: dir, changedFiles: ['src/panel.tsx', 'src/a b/model.ts', 'README.md', 'src/deleted.ts'] })
    expect(out.map((c) => [c.name, c.skip, c.command])).toEqual([
      ['typecheck', false, 'pnpm typecheck'],
      ['lint', false, 'pnpm exec eslint src/panel.tsx "src/a b/model.ts"'],
      ['build', true, 'pnpm build'],
      ['test', false, 'pnpm exec vitest run --passWithNoTests tests/panel.test.ts'],
    ])
  })

  it('skips tests and lint for a task that changed no source file', () => {
    project({ test: 'vitest run', lint: 'eslint .' }, [])
    const out = scopeTaskChecks({ checks, order: ORDER, cwd: dir, changedFiles: ['docs/notes.md'] })
    expect(out.find((c) => c.name === 'test')).toMatchObject({ skip: true })
    expect(out.find((c) => c.name === 'lint')).toMatchObject({ skip: true })
  })

  it('leaves alone what it cannot read exactly, and jest gets --findRelatedTests', () => {
    project({ test: 'vitest run && node check.js', lint: 'eslint --fix .' }, ['src/x.ts'])
    let out = scopeTaskChecks({ checks, order: ORDER, cwd: dir, changedFiles: ['src/x.ts'] })
    expect(out.find((c) => c.name === 'test')).toMatchObject({ scope: 'FULL', command: 'pnpm test' })
    expect(out.find((c) => c.name === 'lint')).toMatchObject({ scope: 'FULL', command: 'pnpm lint' })
    project({ test: 'jest' }, ['src/x.ts'])
    out = scopeTaskChecks({ checks: { test: 'npm test' }, order: ORDER, cwd: dir, changedFiles: ['src/x.ts'] })
    expect(out[0]?.command).toBe('npm exec jest --passWithNoTests --findRelatedTests src/x.ts')
  })

  it('keeps the build when there is no type check', () => {
    project({ build: 'vite build' }, [])
    expect(scopeTaskChecks({ checks: { build: 'pnpm build' }, order: ORDER, cwd: dir, changedFiles: [] })[0]).toMatchObject({ skip: false, scope: 'FULL' })
  })

  it('reads which script a check command runs', () => {
    expect(scriptOf('pnpm test')).toEqual({ pm: 'pnpm', script: 'test' })
    expect(scriptOf('npm run lint')).toEqual({ pm: 'npm', script: 'lint' })
    expect(scriptOf('make test')).toBeNull()
    expect(scriptOf('pnpm exec vitest')).toBeNull()
  })
})

// 0.9.1: the owner's choice of the affected tests only for a mission's final verification.
describe('scopeFinalChecks', () => {
  beforeAll(() => mkdirSync(dir, { recursive: true }))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('scopes only the tests, keeps the type check, linter and build whole, and says the whole suite was not run', () => {
    project({ test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build' }, ['src/panel.tsx'])
    mkdirSync(join(dir, 'tests'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'panel.test.ts'), "import { x } from '../src/panel'\n")
    const out = scopeFinalChecks({ checks, order: ORDER, cwd: dir, changedFiles: ['src/panel.tsx'] })
    expect(out.map((c) => [c.name, c.scope, c.skip, c.command])).toEqual([
      ['typecheck', 'FULL', false, 'pnpm typecheck'],
      ['lint', 'FULL', false, 'pnpm lint'],
      ['build', 'FULL', false, 'pnpm build'],
      ['test', 'CHANGED', false, 'pnpm exec vitest run --passWithNoTests tests/panel.test.ts'],
    ])
    expect(out[3]?.note).toBe('Affected tests only (Settings > Execution > Final tests): The 1 test file(s) that name the files the mission changed. The whole suite was not run.')
    const none = scopeFinalChecks({ checks, order: ORDER, cwd: dir, changedFiles: ['README.md'] })
    expect(none[3]).toMatchObject({ skip: true, note: 'Affected tests only (Settings > Execution > Final tests): no test names a file the mission changed. The whole suite was not run.' })
  })
})

// 0.9.1: a full run of NEXUS's suite failed on one test that raced git; the mission repaired it and ran 22 minutes again.
describe('failedTestFiles and rerunTestsCommand', () => {
  const vitestOutput = [
    ' FAIL  |integration| tests/scenarios/read-snapshot.test.ts > scenario: a read-only run > reads the base commit',
    "Error: git branch --list failed: warning: unable to access '.git/config': Permission denied",
    ' Test Files  1 failed | 289 passed | 7 skipped (297)',
    '      Tests  1 failed | 5465 passed | 77 skipped (5543)',
  ].join('\n')

  it('reads the failed files when the output accounts for every failure', () => {
    expect(failedTestFiles(vitestOutput)).toEqual(['tests/scenarios/read-snapshot.test.ts'])
    expect(failedTestFiles('FAIL tests/a.test.js\nFAIL tests/b.test.js\nTest Suites: 2 failed, 10 passed, 12 total')).toEqual(['tests/a.test.js', 'tests/b.test.js'])
  })

  it('says nothing when the output does not account for the failure exactly', () => {
    expect(failedTestFiles(`${vitestOutput}\nVitest caught 1 unhandled error\nUnhandled Error`)).toBeNull()
    expect(failedTestFiles(vitestOutput.replace('1 failed | 289', '2 failed | 288'))).toBeNull()
    expect(failedTestFiles('Error: Projects "a" and "b" have different maxWorkers\n Test Files  no tests')).toBeNull()
    const many = Array.from({ length: 6 }, (_, i) => ` FAIL  tests/t${i}.test.ts > x`).join('\n')
    expect(failedTestFiles(`${many}\n Test Files  6 failed | 1 passed`)).toBeNull()
  })

  it('runs only those files again, with the project test runner', () => {
    project({ test: 'vitest run' }, [])
    expect(rerunTestsCommand(dir, 'pnpm test', ['tests/a b.test.ts', 'tests/c.test.ts'])).toBe('pnpm exec vitest run "tests/a b.test.ts" tests/c.test.ts')
    project({ test: 'jest' }, [])
    expect(rerunTestsCommand(dir, 'npm test', ['t/a.test.js'])).toBe('npm exec jest t/a.test.js')
    project({ test: 'node --test' }, [])
    expect(rerunTestsCommand(dir, 'npm test', ['t/a.test.js'])).toBeNull()
  })
})

// 0.9.1: one change to progress/service.ts chose the 19 test files importing any module called "service".
describe('testsNaming', () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('names a module with its folder, and a test beside its source by ./name', () => {
    project({}, [])
    for (const d of ['src/progress', 'src/billing', 'tests']) mkdirSync(join(dir, d), { recursive: true })
    writeFileSync(join(dir, 'src/progress/service.ts'), 'export {}\n')
    writeFileSync(join(dir, 'src/billing/service.ts'), 'export {}\n')
    writeFileSync(join(dir, 'tests/progress.test.ts'), "import { x } from '../src/progress/service'\n")
    writeFileSync(join(dir, 'tests/billing.test.ts'), "import { y } from '../src/billing/service'\n")
    writeFileSync(join(dir, 'src/progress/service.test.ts'), "import { x } from './service'\n")
    writeFileSync(join(dir, 'src/billing/other.test.ts'), "import { y } from './service'\n")
    expect(testsNaming(dir, ['src/progress/service.ts'])).toEqual(['src/progress/service.test.ts', 'tests/progress.test.ts'])
  })
})
