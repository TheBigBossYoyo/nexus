import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
