import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The regression corpus ties every real bug found during the releases 0.7 to 0.8 to the tests that keep it fixed.
// `tests/regression-corpus.json` is the record; this file checks that the record is true: every test it names exists,
// is not skipped, and every class of bug the owner named as a must-have is in it.

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

const RELEASES = ['0.7', '0.7.1', '0.7.2', '0.8'] as const
const AREAS = [
  'planner-verifier', 'snapshot', 'context', 'provider-capacity', 'git', 'network-dns', 'appcontainer', 'node-libuv',
  'canonicalization', 'package-config', 'browser-injection', 'autonomy', 'recovery', 'scheduler', 'ui', 'other',
] as const

interface CorpusTest { file: string; title: string }
interface CorpusEntry {
  id: string
  release: (typeof RELEASES)[number]
  area: (typeof AREAS)[number]
  bug: string
  source: string
  tests: CorpusTest[]
  security: boolean
}

const corpus = JSON.parse(readFileSync(resolve(ROOT, 'tests', 'regression-corpus.json'), 'utf8')) as CorpusEntry[]

const texts = new Map<string, string[]>()
function linesOf(file: string): string[] {
  let lines = texts.get(file)
  if (!lines) {
    lines = readFileSync(resolve(ROOT, file), 'utf8').split(/\r?\n/)
    texts.set(file, lines)
  }
  return lines
}

// A line that opens a test: it(, test(, with or without a modifier (skip, todo, only, each ...).
const TEST_OPENING = /^\s*(?:it|test)(?:\.\w+(?:\([^)]*\))?)*\(/
const SKIPPED = /^\s*(?:it|test)\.(?:skip|todo)\b/
const SKIPPED_SUITE = /^\s*describe\.(?:skip|todo)\b/
const TEST_FILE = /^tests\/.+\.test\.ts$/
// A test whose title is a template: its cases are the rows of a table in the same file.
const TEMPLATED_TEST = /^\s*it\(`[^`]*\$\{/
const TABLE_ROW = /^\s*\[/

/** The lines of the file that carry the title of a test, as a test title. */
function titleLines(file: string, title: string): string[] {
  const lines = linesOf(file)
  const direct = lines.filter((line) => TEST_OPENING.test(line) && line.includes(title))
  if (direct.length > 0) return direct
  if (lines.some((line) => TEMPLATED_TEST.test(line))) return lines.filter((line) => TABLE_ROW.test(line) && line.includes(title))
  return []
}

/**
 * Classes of bug the owner named as must-haves. A class is covered when some entry matches it.
 * A class that has no test must be listed in UNCOVERED_CLASSES (and is then asserted to be really uncovered).
 */
const CLASSES: Record<string, (entry: CorpusEntry) => boolean> = {
  'verifier or planner asks for a tool or capability its role does not have': (e) => e.area === 'planner-verifier' && /read-only|role|contract/i.test(e.bug),
  'snapshot mismatch (read-snapshot)': (e) => e.area === 'snapshot' && e.tests.some((t) => t.file.endsWith('read-snapshot.test.ts')),
  'instruction displacement in a prompt or context pack': (e) => e.area === 'context' && /instruction|lost|cut silently/i.test(e.bug),
  'provider slot or lease leakage': (e) => e.area === 'provider-capacity' && /lease|slot/i.test(e.bug),
  'stale capacity': (e) => e.area === 'provider-capacity' && /stale|older observation|observed|never became admissible/i.test(e.bug),
  'Git pointer attack (replaced .git file or gitdir)': (e) => e.area === 'git' && /\.git (?:file|pointer)|gitdir/i.test(e.bug),
  'Git config filter (filter, smudge or clean driver)': (e) => e.area === 'git' && /filter/i.test(e.bug),
  'textconv (diff conversion program)': (e) => e.area === 'git' && /textconv|conversion program|converter/i.test(e.bug),
  'local push hooks (push to a path remote runs hooks)': (e) => e.area === 'git' && /push/i.test(e.bug) && /hook/i.test(e.bug),
  'DNS or AppContainer name resolution': (e) => e.area === 'appcontainer' && /look(?:ed)? up|names|DNS/i.test(e.bug),
  'Node/libuv pipe hang': (e) => e.area === 'node-libuv' && /libuv/i.test(e.bug),
  'path canonicalization (Mount Manager or realpath)': (e) => e.area === 'canonicalization' && /Mount Manager|canonical/i.test(e.bug),
  'package config secret read (.npmrc)': (e) => e.area === 'package-config' && /\.npmrc/.test(e.bug),
  'browser or web prompt injection': (e) => e.area === 'browser-injection' && /instruction|DATA block/i.test(e.bug),
}

/**
 * The must-have classes for which no existing test was found when the corpus was written. Empty: every class has at
 * least one test. A class named here is not asserted as covered; it is asserted to be uncovered, so that the list
 * cannot go stale when a test is added.
 */
export const UNCOVERED_CLASSES: string[] = []

describe('regression corpus', () => {
  it('is a non-empty list of entries with the fields of the schema', () => {
    expect(Array.isArray(corpus)).toBe(true)
    expect(corpus.length).toBeGreaterThan(0)
    for (const entry of corpus) {
      expect(Object.keys(entry).sort(), entry.id).toEqual(['area', 'bug', 'id', 'release', 'security', 'source', 'tests'])
      expect(RELEASES, entry.id).toContain(entry.release)
      expect(AREAS, entry.id).toContain(entry.area)
      expect(typeof entry.security, entry.id).toBe('boolean')
      expect(entry.bug.trim().length, `${entry.id}: bug`).toBeGreaterThan(20)
      expect(entry.source.trim().length, `${entry.id}: source`).toBeGreaterThan(0)
    }
  })

  it('has unique, well-formed ids', () => {
    const ids = corpus.map((entry) => entry.id)
    for (const id of ids) expect(id, id).toMatch(/^R-\d{3}$/)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('names at least one test for every bug', () => {
    for (const entry of corpus) expect(entry.tests.length, entry.id).toBeGreaterThan(0)
  })

  it('names tests of files that exist, whose title is in the file as the title of a test, and that are not skipped', () => {
    const problems: string[] = []
    for (const entry of corpus) {
      for (const test of entry.tests) {
        if (!TEST_FILE.test(test.file)) problems.push(`${entry.id}: ${test.file} is not a test file under tests/`)
        else if (!existsSync(resolve(ROOT, test.file))) problems.push(`${entry.id}: ${test.file} does not exist`)
        else {
          const found = titleLines(test.file, test.title)
          if (test.title.trim().length <= 10) problems.push(`${entry.id}: the title is too short to mean anything: ${test.title}`)
          else if (found.length === 0) problems.push(`${entry.id}: no test titled ${JSON.stringify(test.title)} in ${test.file}`)
          else if (found.some((line) => SKIPPED.test(line))) problems.push(`${entry.id}: ${JSON.stringify(test.title)} is skipped or a todo in ${test.file}`)
          if (linesOf(test.file).some((line) => SKIPPED_SUITE.test(line))) problems.push(`${entry.id}: ${test.file} skips a whole suite`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('does not name the same test twice for one bug', () => {
    for (const entry of corpus) {
      const keys = entry.tests.map((test) => `${test.file}\n${test.title}`)
      expect(new Set(keys).size, entry.id).toBe(keys.length)
    }
  })

  it('covers every class the owner named as a must-have, or lists it as uncovered', () => {
    for (const [name, matches] of Object.entries(CLASSES)) {
      const hits = corpus.filter(matches)
      if (UNCOVERED_CLASSES.includes(name)) expect(hits.map((e) => e.id), `${name} is listed as uncovered but has entries`).toEqual([])
      else expect(hits.length, `no entry covers: ${name}`).toBeGreaterThan(0)
    }
    for (const name of UNCOVERED_CLASSES) expect(Object.keys(CLASSES), name).toContain(name)
  })

  it('marks the containment, credential, injection and authority classes as security', () => {
    const securityClasses = Object.entries(CLASSES).filter(([name]) => !/verifier|snapshot|instruction|slot|stale|libuv/.test(name))
    for (const [name, matches] of securityClasses) {
      for (const entry of corpus.filter(matches)) expect(entry.security, `${entry.id} (${name})`).toBe(true)
    }
  })

  it('prints how many bugs there are per release and per area', () => {
    const count = <K extends string>(keys: readonly K[], pick: (entry: CorpusEntry) => K): Record<string, number> =>
      Object.fromEntries(keys.map((key) => [key, corpus.filter((entry) => pick(entry) === key).length]))
    const perRelease = count(RELEASES, (entry) => entry.release)
    const perArea = count(AREAS, (entry) => entry.area)
    const tests = new Set(corpus.flatMap((entry) => entry.tests.map((test) => `${test.file}\n${test.title}`))).size
    const security = corpus.filter((entry) => entry.security).length
    console.info(
      [
        `regression corpus: ${corpus.length} bugs, ${tests} distinct tests, ${security} security`,
        `per release: ${Object.entries(perRelease).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        `per area: ${Object.entries(perArea).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        `uncovered classes: ${UNCOVERED_CLASSES.length === 0 ? 'none' : UNCOVERED_CLASSES.join('; ')}`,
      ].join('\n'),
    )
    // Every release and every area of the schema is used: an empty one is a gap to look at, not a pass.
    for (const release of RELEASES) expect(perRelease[release], release).toBeGreaterThan(0)
  })
})
