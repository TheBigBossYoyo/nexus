// Mutation check of the agent-written tests.
//
// The project is copied to a temporary directory three ways: with the pristine sources (the agent's
// tests must pass), and once per mutant (the agent's tests must fail for most of them). Sources are
// always taken from ./pristine, never mutated in place, so edits the agent made under src/ are ignored.
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
  const r = spawnSync(process.execPath, ['--test'], { cwd: dir, env, encoding: 'utf8', timeout: 30000 })
  return { status: r.status, signal: r.signal, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('mutant definitions are valid against the pristine sources', () => {
  for (const m of MUTANTS) {
    const source = readFileSync(join(pristine, m.file), 'utf8')
    assert.equal(source.split(m.from).length - 1, 1, `${m.id}: pattern must occur exactly once in ${m.file}`)
    assert.notEqual(m.from, m.to)
  }
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
      if (r.status !== 0) killed++
      else survivors.push(`${m.id} (${m.note})`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  assert.ok(killed >= REQUIRED_KILLS, `killed ${killed}/${MUTANTS.length}; survivors: ${survivors.join('; ')}`)
})
