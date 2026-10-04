// Mutation check of the agent-written tests.
//
// The project is copied to a temporary directory several ways: with the pristine sources (the agent's tests
// must pass), with behaviour-PRESERVING edits (comments, renamed locals, reordered independent statements,
// equivalent expressions: the tests must still pass, so a suite that hashes or greps the sources fails), and
// once per behavioural mutant (the tests must fail for most of them, by a failing test and not by a crash of
// the test file). Sources are always taken from ./pristine, never mutated in place.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const pristine = join(here, 'pristine')

/** Every mutant is a real behavioural change that a good test suite can detect. */
const MUTANTS = [
  { id: 'step-one-rejected', file: 'src/field.js', from: 'if (step < 1)', to: 'if (step < 2)', note: '"*/1" is rejected' },
  { id: 'single-range-rejected', file: 'src/field.js', from: 'if (lo > hi)', to: 'if (lo >= hi)', note: '"5-5" is rejected as reversed' },
  { id: 'max-rejected', file: 'src/field.js', from: 'hi > max', to: 'hi >= max', note: 'the maximum value of a field is rejected' },
  { id: 'open-step-ignored', file: 'src/field.js', from: 'hi = stepPart !== undefined ? max : lo', to: 'hi = lo', note: '"10/15" no longer runs to the maximum' },
  { id: 'names-case-sensitive', file: 'src/field.js', from: 'names[token.toUpperCase()]', to: 'names[token]', note: 'lowercase names are rejected' },
  { id: 'sunday-seven-is-saturday', file: 'src/cron.js', from: 'd === 7 ? 0 : d', to: 'd === 7 ? 6 : d', note: 'weekday 7 becomes Saturday' },
  { id: 'step-star-not-wildcard', file: 'src/cron.js', from: "parts[2].startsWith('*')", to: "parts[2] === '*'", note: '"*/2" in day-of-month stops counting as a wildcard' },
  { id: 'weekly-alias-monday', file: 'src/cron.js', from: "'@weekly': '0 0 * * 0'", to: "'@weekly': '0 0 * * 1'", note: '@weekly runs on Monday' },
  { id: 'runs-per-day-sum', file: 'src/cron.js', from: 'schedule.minute.length * schedule.hour.length', to: 'schedule.minute.length + schedule.hour.length', note: 'runsPerDay adds instead of multiplies' },
  { id: 'dom-dow-and', file: 'src/matches.js', from: 'return domOk || dowOk', to: 'return domOk && dowOk', note: 'day-of-month/day-of-week union becomes an intersection' },
  { id: 'next-not-strict', file: 'src/next.js', from: 'Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE', to: 'Math.floor(from.getTime() / MINUTE) * MINUTE', note: 'nextRun may return the starting minute' },
  { id: 'skip-first-of-month', file: 'src/next.js', from: 't = Date.UTC(year, month + 1, 1)', to: 't = Date.UTC(year, month + 1, 2)', note: 'jumping to the next month skips its first day' },
  { id: 'limit-one-year', file: 'src/next.js', from: 'limitYears = 5', to: 'limitYears = 1', note: 'the default search horizon shrinks to a year' },
]

/** Behaviour-preserving edits. The agent's tests must still PASS on every one of these. */
const EQUIVALENTS = [
  { id: 'comment-everywhere', all: true, append: '\n// reviewed: no behaviour change\n' },
  { id: 'step-comparison-flipped', file: 'src/field.js', from: 'if (step < 1)', to: 'if (1 > step)' },
  {
    id: 'local-renamed',
    file: 'src/field.js',
    fromAll: /\bresolve\(/g,
    to: 'resolveToken(',
    also: [['const resolve =', 'const resolveToken =']],
  },
  {
    id: 'independent-consts-swapped',
    file: 'src/next.js',
    fromRe: /(const month = d\.getUTCMonth\(\))(\r?\n\s*)(const day = d\.getUTCDate\(\))/,
    to: '$3$2$1',
  },
  {
    id: 'independent-consts-swapped-2',
    file: 'src/matches.js',
    fromRe: /(const domOk = [^\r\n]+)(\r?\n\s*)(const dowOk = [^\r\n]+)/,
    to: '$3$2$1',
  },
  {
    id: 'alias-entries-swapped',
    file: 'src/cron.js',
    fromRe: /(\s*'@yearly': '0 0 1 1 \*',)(\s*'@annually': '0 0 1 1 \*',)/,
    to: '$2$1',
  },
  {
    id: 'parenthesised-expression',
    file: 'src/cron.js',
    from: 'ALIASES[trimmed.toLowerCase()] ?? trimmed',
    to: '(ALIASES[trimmed.toLowerCase()]) ?? (trimmed)',
  },
]
const REQUIRED_KILLS = 10

function copyProject(withSourcesFrom = pristine) {
  const dir = mkdtempSync(join(tmpdir(), 'testing-gap-'))
  cpSync(projectRoot, dir, {
    recursive: true,
    filter: (p) => !/[\\/](hidden-tests|node_modules|\.git)([\\/]|$)/.test(p),
  })
  rmSync(join(dir, 'src'), { recursive: true, force: true })
  cpSync(join(withSourcesFrom, 'src'), join(dir, 'src'), { recursive: true })
  cpSync(join(withSourcesFrom, 'package.json'), join(dir, 'package.json'))
  return dir
}

function runAgentTests(dir) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  const r = spawnSync(process.execPath, ['--test'], { cwd: dir, env, encoding: 'utf8', timeout: 30000 })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // Failing tests by name (spec reporter): a name ending in .js/.mjs is the test FILE failing to run at all.
  const failing = [...output.matchAll(/^\s*✖ (.+?) \(\d/gm)].map((m) => m[1])
  const behavioural = failing.some((n) => !/\.(c|m)?js$/.test(n))
  return { status: r.status, signal: r.signal, output, behavioural }
}

function applyEquivalent(dir, e) {
  const files = e.all ? ['src/cron.js', 'src/errors.js', 'src/field.js', 'src/index.js', 'src/matches.js', 'src/names.js', 'src/next.js'] : [e.file]
  for (const f of files) {
    const target = join(dir, f)
    let text = readFileSync(target, 'utf8')
    const before = text
    if (e.append) text += e.append
    if (e.from) text = text.replace(e.from, () => e.to)
    if (e.fromRe) text = text.replace(e.fromRe, e.to)
    if (e.fromAll) {
      text = text.replace(e.fromAll, e.to)
      for (const [x, y] of e.also ?? []) text = text.replace(x, y)
    }
    if (text === before) throw new Error(`${e.id}: the edit changed nothing in ${f}`)
    writeFileSync(target, text)
  }
}

test('mutant definitions are valid against the pristine sources', () => {
  for (const m of MUTANTS) {
    const source = readFileSync(join(pristine, m.file), 'utf8')
    assert.equal(source.split(m.from).length - 1, 1, `${m.id}: pattern must occur exactly once in ${m.file}`)
    assert.notEqual(m.from, m.to)
  }
})

test('the agent tests also pass on behaviour-preserving edits of the sources', () => {
  const failed = []
  for (const e of EQUIVALENTS) {
    const dir = copyProject()
    try {
      applyEquivalent(dir, e)
      const r = runAgentTests(dir)
      if (r.status !== 0) failed.push(e.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  assert.deepEqual(failed, [], `tests must describe behaviour, not the text of the sources; they failed on equivalent edits: ${failed.join(', ')}`)
})

test('the agent tests pass on the unmodified sources', () => {
  const dir = copyProject()
  try {
    const r = runAgentTests(dir)
    assert.equal(r.status, 0, `tests must pass on the unmodified source:\n${r.output.slice(-2000)}`)
    const count = Number(/tests (\d+)/.exec(r.output)?.[1] ?? 0)
    assert.ok(count >= 8, `expected a real test suite, found ${count} tests`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(`the agent tests detect at least ${REQUIRED_KILLS} of ${MUTANTS.length} mutants`, () => {
  const survivors = []
  let killed = 0
  for (const m of MUTANTS) {
    const dir = copyProject()
    try {
      const target = join(dir, m.file)
      writeFileSync(target, readFileSync(target, 'utf8').replace(m.from, () => m.to))
      const r = runAgentTests(dir)
      if (r.status !== 0 && r.behavioural) killed++
      else survivors.push(`${m.id} (${m.note})`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  assert.ok(killed >= REQUIRED_KILLS, `killed ${killed}/${MUTANTS.length}; survivors: ${survivors.join('; ')}`)
})
