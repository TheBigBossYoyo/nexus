import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NexusError } from '@shared/result'
import {
  hashDirectory,
  importCase,
  loadCaseDirectory,
  registerCases,
  trustCaseVersion,
} from '@main/modules/arena/case-format'
import { definition, writeCase } from './helpers'
import { loadVerifiedCase, listFilesRecursive } from '@main/modules/arena/case-format'
import { cleanEnv } from '@main/modules/arena/env'
import { nothingRan, testsReported } from '@main/modules/arena/evaluator'
import { openMemory } from '../../integration/persistence/fixtures'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'arena-unit-'))
  dirs.push(d)
  return d
}

describe('case format', () => {
  it('validates case.json and rejects shell operators in commands', () => {
    const root = tmp()
    const ok = writeCase(root)
    expect(loadCaseDirectory(ok).definition.id).toBe('demo-case')
    writeFileSync(join(ok, 'case.json'), JSON.stringify(definition({ complexity: 'huge' })))
    expect(() => loadCaseDirectory(ok)).toThrow(/Invalid case definition/)
    writeFileSync(join(ok, 'case.json'), JSON.stringify(definition({ setup: ['npm i && rm -rf x'] })))
    expect(() => loadCaseDirectory(ok)).toThrow(NexusError)
    writeFileSync(join(ok, 'case.json'), '{nope')
    expect(() => loadCaseDirectory(ok)).toThrow(/not valid JSON/)
  })

  it('hashes by path and content, independent of line endings', () => {
    const root = tmp()
    const a = writeCase(join(root, 'a'), {}, 'x\ny\n')
    const b = writeCase(join(root, 'b'), {}, 'x\r\ny\r\n')
    expect(hashDirectory(join(a, 'evaluator'))).toBe(hashDirectory(join(b, 'evaluator')))
    writeFileSync(join(b, 'evaluator', 'hidden-tests', 'a.test.mjs'), 'x\ny!\n')
    expect(hashDirectory(join(a, 'evaluator'))).not.toBe(hashDirectory(join(b, 'evaluator')))
    writeFileSync(join(b, 'evaluator', 'hidden-tests', 'a.test.mjs'), 'x\ny\n')
    writeFileSync(join(b, 'evaluator', 'hidden-tests', 'extra.txt'), '')
    expect(hashDirectory(join(a, 'evaluator'))).not.toBe(hashDirectory(join(b, 'evaluator')))
  })

  it('the evaluator hash covers the evaluation command', () => {
    const root = tmp()
    const a = loadCaseDirectory(writeCase(join(root, 'a')))
    const b = loadCaseDirectory(writeCase(join(root, 'b'), { hiddenEvaluation: { command: 'node --test other/', timeoutSeconds: 60 } }))
    expect(a.evaluatorHash).not.toBe(b.evaluatorHash)
  })

  it('registers a new version when the version increases and refuses a changed evaluator under the same version', () => {
    const { repos } = openMemory()
    const root = tmp()
    writeCase(root)
    expect(registerCases(repos, root, 'builtin')[0]!.created).toBe(true)
    expect(registerCases(repos, root, 'builtin')[0]!.created).toBe(false)
    expect(repos.arenaCaseVersions.latest('demo-case')!.trusted).toBe(true)

    writeFileSync(join(root, 'demo-case', 'evaluator', 'hidden-tests', 'a.test.mjs'), 'changed')
    expect(() => registerCases(repos, root, 'builtin')).toThrow(/evaluator .* changed without a version bump/)
    try {
      registerCases(repos, root, 'builtin')
    } catch (e) {
      expect((e as NexusError).code).toBe('invalid_state')
    }

    writeCase(root, { version: 2 }, 'changed')
    registerCases(repos, root, 'builtin')
    expect(repos.arenaCases.require('demo-case').latestVersion).toBe(2)
    expect(repos.arenaCaseVersions.listByCase('demo-case')).toHaveLength(2)
    // versions only increase
    writeCase(root, { version: 1 }, 'something else')
    expect(() => registerCases(repos, root, 'builtin')).toThrow()
  })

  it('refuses a changed fixture under the same version', () => {
    const { repos } = openMemory()
    const root = tmp()
    writeCase(root)
    registerCases(repos, root, 'builtin')
    writeFileSync(join(root, 'demo-case', 'fixture', 'index.js'), 'export const x = 2\n')
    expect(() => registerCases(repos, root, 'builtin')).toThrow(/fixture/)
  })

  it('imports untrusted with the commands, and trusts only what was imported', () => {
    const { repos } = openMemory()
    const root = tmp()
    const dir = writeCase(root, { setup: ['node --version'] })
    const imported = importCase(repos, dir)
    expect(imported.summary.case.origin).toBe('imported')
    expect(imported.summary.version.trusted).toBe(false)
    expect(imported.commands).toEqual(['setup: node --version', 'check: node --test', 'hidden evaluation: node --test hidden-tests/'])

    writeFileSync(join(dir, 'evaluator', 'hidden-tests', 'a.test.mjs'), 'edited after import')
    expect(() => trustCaseVersion(repos, imported.summary.version.id)).toThrow(/changed on disk/)
    writeFileSync(join(dir, 'evaluator', 'hidden-tests', 'a.test.mjs'), 'hidden v1')
    expect(trustCaseVersion(repos, imported.summary.version.id).trusted).toBe(true)
  })

  it('an imported case cannot take over a built-in id', () => {
    const { repos } = openMemory()
    const root = tmp()
    registerCases(repos, writeCase(root) && root, 'builtin')
    const other = tmp()
    expect(() => importCase(repos, writeCase(other))).toThrow(/already registered as builtin/)
  })

  describe('the whole definition is pinned (setup, checks, prompt)', () => {
    it('refuses a changed setup under the same version at sync, trust, provisioning and re-import', () => {
      const { repos } = openMemory()
      const root = tmp()
      const dir = writeCase(root, { setup: ['node --version'] })
      const imported = importCase(repos, dir)
      const original = imported.summary.version
      // the commands shown to the user are what was stored
      expect(original.definition.setup).toEqual(['node --version'])

      writeFileSync(join(dir, 'case.json'), JSON.stringify(definition({ setup: ['node -e process.exit(0)'] })))
      expect(() => trustCaseVersion(repos, original.id)).toThrow(/changed on disk/)
      expect(() => importCase(repos, dir)).toThrow(/changed without a version bump/)
      expect(() => loadVerifiedCase(dir, original)).toThrow(/bump its version and review it again/)
      expect(repos.arenaCaseVersions.require(original.id).trusted).toBe(false)
    })

    it('refuses a changed prompt, check or budget, and executes the stored definition', () => {
      const { repos } = openMemory()
      const root = tmp()
      const dir = writeCase(root)
      const stored = importCase(repos, dir).summary.version
      for (const over of [{ taskPrompt: 'Something else.' }, { checks: { build: null, test: 'node other.js', lint: null, typecheck: null } }, { budgets: { maxWallClockMinutes: 21, maxAgentSessions: 20, maxAgentsPerTrial: 2, maxTurnsPerAgent: 60 } }]) {
        writeFileSync(join(dir, 'case.json'), JSON.stringify(definition(over)))
        expect(() => loadVerifiedCase(dir, stored)).toThrow(/changed since it was registered/)
      }
      writeFileSync(join(dir, 'case.json'), JSON.stringify(definition()))
      // key order does not matter, the canonical JSON does
      expect(loadVerifiedCase(dir, stored).definition).toEqual(stored.definition)
    })

    it('a builtin definition changed under the same version is refused at sync', () => {
      const { repos } = openMemory()
      const root = tmp()
      writeCase(root)
      registerCases(repos, root, 'builtin')
      writeFileSync(join(root, 'demo-case', 'case.json'), JSON.stringify(definition({ setup: ['node --version'] })))
      expect(() => registerCases(repos, root, 'builtin')).toThrow(/changed without a version bump/)
    })
  })

  it('rejects any .git entry in a fixture or an evaluator, at any depth', () => {
    const root = tmp()
    const dir = writeCase(root)
    mkdirSync(join(dir, 'fixture', 'sub', '.git'), { recursive: true })
    writeFileSync(join(dir, 'fixture', 'sub', '.git', 'config'), '[core]\n  fsmonitor = calc.exe\n')
    expect(() => loadCaseDirectory(dir)).toThrow(/\.git entry/)
    rmSync(join(dir, 'fixture', 'sub'), { recursive: true })
    writeFileSync(join(dir, 'evaluator', '.git'), 'gitdir: elsewhere')
    expect(() => loadCaseDirectory(dir)).toThrow(/\.git entry/)
    // a repository scan may skip it explicitly
    expect(listFilesRecursive(dir, { skipGit: true })).not.toContain('evaluator/.git')
  })

  it('caps the number of files of a case directory', () => {
    const root = tmp()
    const dir = writeCase(root)
    mkdirSync(join(dir, 'fixture', 'many'))
    for (let i = 0; i < 5100; i++) writeFileSync(join(dir, 'fixture', 'many', 'f' + i + '.txt'), '')
    expect(() => loadCaseDirectory(dir)).toThrow(/more than 5000 files/)
  })
})

describe('evaluator environment and output', () => {
  it('withholds credentials and Node redirection from case commands', () => {
    const env = cleanEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', NODE_OPTIONS: '--require x', NODE_PATH: '/x', PATH: '/bin', HOME: '/h' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' })
  })

  it('reads the Node test runner summary and treats a run of nothing as infrastructure', () => {
    expect(testsReported('ℹ tests 12\nℹ pass 12')).toBe(12)
    expect(testsReported('# tests 0\n# pass 0')).toBe(0)
    expect(testsReported('nothing')).toBeNull()
    const cmd = 'node --test hidden-tests/a.test.mjs'
    expect(nothingRan(cmd, 'ℹ tests 0\nℹ pass 0', 0)).toBe(true)
    expect(nothingRan(cmd, "Could not find 'hidden-tests/a.test.mjs'", 1)).toBe(true)
    expect(nothingRan(cmd, 'no summary', 0)).toBe(true)
    expect(nothingRan(cmd, 'ℹ tests 3\nℹ fail 1', 1)).toBe(false)
    expect(nothingRan(cmd, 'ℹ tests 0', 1, true)).toBe(false)
    expect(nothingRan('python -m pytest', 'ℹ tests 0', 0)).toBe(false)
  })
})
