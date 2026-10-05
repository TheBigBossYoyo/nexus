import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectProfile } from '@shared/domain'
import type { RepositoryFact } from '@shared/v2'
import {
  CATEGORY_RULES,
  PROFILER_VERSION,
  inferAmbiguity,
  inferCategory,
  inferComplexity,
  inferRisk,
  measureTestDensity,
  profileTask,
} from '@main/modules/policy'
import type { TaskCategory } from '@shared/v3'

const ids = { id: 'tp1', projectId: 'p', runId: 'r', arenaTrialId: null, createdAt: '2026-01-01T00:00:00.000Z' }

const profile: ProjectProfile = {
  repoRoot: '/repo',
  isGitRepo: true,
  currentBranch: 'main',
  headCommit: 'abc',
  dirty: false,
  packageManagers: ['pnpm'],
  languages: ['TypeScript', 'CSS'],
  frameworks: ['React'],
  scripts: {},
  commands: { build: null, test: null, lint: null, typecheck: null },
  docs: [],
  hasClaudeMd: false,
  fileCount: 120,
  sizeBytes: 1,
  generatedPaths: [],
  profiledAt: '2026-01-01T00:00:00.000Z',
}

const fact = (kind: RepositoryFact['kind'], subject: string, statement = subject): RepositoryFact => ({
  id: `${kind}-${subject}`,
  projectId: 'p',
  kind,
  subject,
  statement,
  source: 'static_analysis',
  confidence: 'low',
  files: [],
  fingerprint: '',
  stale: false,
  createdAt: '',
  verifiedAt: '',
})

describe('category rules', () => {
  const cases: [string, TaskCategory][] = [
    ['Fix the crash when the user clicks save in src/app.ts', 'bugfix'],
    ['Add unit tests for the parser to improve coverage', 'testing'],
    ['Refactor the scheduler module and rename the helper functions', 'refactor'],
    ['Migrate the database from SQLite to Postgres', 'migration'],
    ['Optimize the slow query to reduce latency', 'performance'],
    ['Fix the SQL injection vulnerability in the login form', 'security'],
    ['Make the settings page button responsive with CSS', 'ui'],
    ['Set up a GitHub Actions pipeline that builds a docker image', 'infrastructure'],
    ['Redesign the system architecture into microservices', 'architecture'],
    ['Add a new export option for reports', 'feature'],
  ]
  for (const [prompt, category] of cases) {
    it(`"${prompt}" is ${category}`, () => expect(inferCategory(prompt)).toBe(category))
  }

  it('falls back to feature when nothing matches', () => {
    expect(inferCategory('hello world')).toBe('feature')
  })

  it('exports one rule per category for citation', () => {
    expect(new Set(CATEGORY_RULES.map((r) => r.category)).size).toBe(10)
  })
})

describe('complexity, risk, ambiguity', () => {
  it('a typo fix is small and low risk', () => {
    expect(inferComplexity('Fix a typo in README.md', 'bugfix')).toBe('small')
    expect(inferRisk('Fix a typo in README.md', 'bugfix')).toBe('low')
  })

  it('long multi-deliverable prompts grow to large', () => {
    const prompt = [
      'Rework the billing module across the entire codebase:',
      '- add invoice export',
      '- update the tax calculation',
      '- replace the old client',
      '- write the migration',
      '- document the new API',
      '- remove the legacy endpoints',
    ].join('\n')
    expect(inferComplexity(prompt, 'feature')).toBe('large')
  })

  it('risk keywords: production and payments are high, auth alone is medium', () => {
    expect(inferRisk('Deploy the payment changes to production', 'infrastructure')).toBe('high')
    expect(inferRisk('Tweak the auth redirect', 'bugfix')).toBe('medium')
    expect(inferRisk('Migrate the schema and drop the table', 'migration')).toBe('high')
  })

  it('a specific prompt is less ambiguous than a vague one', () => {
    expect(inferAmbiguity('Return 404 from src/api/users.ts when the user is missing, and ensure the test covers it')).toBe('low')
    expect(inferAmbiguity('make it better')).toBe('high')
  })
})

describe('profileTask', () => {
  it('measures repository features and infers the rest, with the right bases', () => {
    const facts = [
      fact('module', 'src/main'),
      fact('module', 'src/renderer'),
      fact('test_mapping', 'tests/a.test.ts'),
      fact('test_mapping', 'tests/b.test.ts'),
    ]
    const p = profileTask({ prompt: 'Fix the crash in src/main/a.ts', profile, facts, ids })
    expect(p.profilerVersion).toBe(PROFILER_VERSION)
    expect(p.features.primaryLanguage).toEqual({ value: 'TypeScript', basis: 'MEASURED' })
    expect(p.features.frameworks).toEqual({ value: ['React'], basis: 'MEASURED' })
    expect(p.features.repoFileCount).toEqual({ value: 120, basis: 'MEASURED' })
    expect(p.features.moduleCount).toEqual({ value: 2, basis: 'MEASURED' })
    expect(p.features.testDensity.value).toBe(2)
    expect(p.features.category.basis).toBe('INFERRED')
    expect(p.features.fileScope).toEqual({ value: 'single', basis: 'INFERRED' })
    expect(p.contextKey).toBe(`bugfix|${p.features.complexity.value}|${p.features.risk.value}`)
  })

  it('user-specified fields win and are labelled', () => {
    const p = profileTask({
      prompt: 'Fix a typo',
      profile: null,
      facts: [],
      user: { category: 'security', complexity: 'large', risk: 'high' },
      ids,
    })
    expect(p.contextKey).toBe('security|large|high')
    expect(p.features.category.basis).toBe('USER_SPECIFIED')
    expect(p.features.risk.basis).toBe('USER_SPECIFIED')
    expect(p.features.securitySensitive.value).toBe(true)
  })

  it('without a profile or facts the measured features are null, not guessed', () => {
    const p = profileTask({ prompt: 'Add a button', profile: null, facts: [], ids })
    expect(p.features.primaryLanguage.value).toBeNull()
    expect(p.features.repoFileCount.value).toBeNull()
    expect(p.features.moduleCount.value).toBeNull()
    expect(p.features.testDensity.value).toBeNull()
  })

  it('is deterministic', () => {
    const input = { prompt: 'Migrate users to the new auth provider', profile, facts: [], ids }
    expect(profileTask(input)).toEqual(profileTask(input))
  })

  it('test density needs mapping facts and ignores stale ones', () => {
    expect(measureTestDensity([], 100)).toBeNull()
    const stale = { ...fact('test_mapping', 'a.test.ts'), stale: true }
    expect(measureTestDensity([stale], 100)).toBeNull()
    expect(measureTestDensity([fact('test_mapping', 'tests/', 'tests/ holds 10 test files')], 110)).toBe(10)
  })
})

describe('purity', () => {
  it('imports nothing from persistence, the Arena or policy learning', () => {
    const source = readFileSync(resolve(__dirname, '../../../src/main/modules/policy/profiler.ts'), 'utf8')
    const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!)
    expect(imports.length).toBeGreaterThan(0)
    for (const spec of imports) {
      expect(spec.startsWith('@shared/') || spec.startsWith('./')).toBe(true)
      expect(spec).not.toMatch(/persistence|arena|learning|engine|service|stats|simulator/i)
    }
    expect(source).not.toMatch(/Arena(Trial|Campaign)|MissionOutcome|StrategyStatistic/)
  })
})
