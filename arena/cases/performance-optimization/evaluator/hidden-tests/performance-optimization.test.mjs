import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLine, parseLog } from '../src/parse.js'
import { dedupeEvents } from '../src/dedupe.js'
import { rollingErrorRate } from '../src/window.js'
import { serviceTable } from '../src/services.js'
import { percentile, latencySummary } from '../src/percentile.js'
import { buildReport } from '../src/report.js'

// ---------- deterministic data ----------
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR']

function makeEvents(n, { services = 8, messages = 40, seed = 7 } = {}) {
  const r = rng(seed)
  const out = []
  let ts = Date.parse('2024-03-01T00:00:00.000Z')
  for (let i = 0; i < n; i++) {
    // roughly a third of the events share the previous timestamp
    if (r() > 0.34) ts += Math.floor(r() * 400)
    const level = r() < 0.2 ? 'ERROR' : LEVELS[Math.floor(r() * 3)]
    out.push({
      ts,
      level,
      service: `svc-${Math.floor(r() * services)}`,
      latencyMs: Math.floor(r() * 900),
      message: `m${Math.floor(r() * messages)}`,
    })
  }
  return out
}

function toLine(e) {
  return `${new Date(e.ts).toISOString()} ${e.level} ${e.service} ${e.latencyMs}ms ${e.message}`
}

// ---------- oracles (deliberately straightforward) ----------
const oracle = {
  dedupe(events, keyOf) {
    const out = []
    const keys = []
    for (const e of events) {
      const k = keyOf(e)
      if (!keys.includes(k)) {
        keys.push(k)
        out.push(e)
      }
    }
    return out
  },
  window(events, w) {
    return events.map((e) => {
      let total = 0
      let errors = 0
      for (const o of events) {
        if (o.ts <= e.ts && o.ts > e.ts - w) {
          total++
          if (o.level === 'ERROR') errors++
        }
      }
      return { ts: e.ts, total, errors, rate: total === 0 ? 0 : errors / total }
    })
  },
  services(events) {
    const map = new Map()
    for (const e of events) {
      let row = map.get(e.service)
      if (!row) {
        row = { service: e.service, count: 0, errors: 0, sum: 0, max: -Infinity }
        map.set(e.service, row)
      }
      row.count++
      if (e.level === 'ERROR') row.errors++
      row.sum += e.latencyMs
      row.max = Math.max(row.max, e.latencyMs)
    }
    return [...map.values()]
      .map((r) => ({ service: r.service, count: r.count, errors: r.errors, avgLatencyMs: r.sum / r.count, maxLatencyMs: r.max }))
      .sort((a, b) => b.count - a.count || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0))
  },
  percentile(values, p) {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]
  },
  latency(events, ps) {
    const out = {}
    for (const p of ps) out[`p${p}`] = oracle.percentile(events.map((e) => e.latencyMs), p)
    return out
  },
  parseLine(line, levels) {
    const re = new RegExp('^(\\S+)\\s+(' + levels.join('|') + ')\\s+([\\w.-]+)\\s+(\\d+)ms(?:\\s+(.*))?$')
    const m = re.exec(line.trim())
    if (!m || Number.isNaN(Date.parse(m[1]))) return null
    return { ts: Date.parse(m[1]), level: m[2], service: m[3], latencyMs: Number(m[4]), message: m[5] ?? '' }
  },
  parseLog(text, levels) {
    const events = []
    let skipped = 0
    for (const raw of text.split(/\r?\n/)) {
      if (raw.trim() === '') continue
      const e = oracle.parseLine(raw, levels)
      if (e) events.push(e)
      else skipped++
    }
    return { events, skipped }
  },
}

// ---------- instrumentation ----------
class BudgetExceeded extends Error {}

/** Wrap events so that every property read is counted; throws once the budget is spent. */
function countedEvents(raw, limit) {
  const state = { reads: 0 }
  const proxies = raw.map(
    (e) =>
      new Proxy(e, {
        get(target, key, receiver) {
          if (++state.reads > limit) throw new BudgetExceeded(`more than ${limit} event property reads`)
          return Reflect.get(target, key, receiver)
        },
      }),
  )
  return { proxies, state }
}

/** Count calls of Array.prototype methods (and RegExp construction) while `fn` runs synchronously. */
function withCounters(fn, { limit = Infinity } = {}) {
  const counts = { regexp: 0, concat: 0, sort: 0 }
  const OrigRegExp = globalThis.RegExp
  const origConcat = Array.prototype.concat
  const origSort = Array.prototype.sort
  const origToSorted = Array.prototype.toSorted
  const bump = (name) => {
    if (++counts[name] > limit) throw new BudgetExceeded(`more than ${limit} ${name} calls`)
  }
  globalThis.RegExp = new Proxy(OrigRegExp, {
    construct(target, args) {
      bump('regexp')
      return Reflect.construct(target, args)
    },
    apply(target, thisArg, args) {
      bump('regexp')
      return Reflect.apply(target, thisArg, args)
    },
  })
  Array.prototype.concat = function (...args) {
    bump('concat')
    return origConcat.apply(this, args)
  }
  Array.prototype.sort = function (...args) {
    bump('sort')
    return origSort.apply(this, args)
  }
  Array.prototype.toSorted = function (...args) {
    bump('sort')
    return origToSorted.apply(this, args)
  }
  try {
    const result = fn()
    return { result, counts }
  } finally {
    globalThis.RegExp = OrigRegExp
    Array.prototype.concat = origConcat
    Array.prototype.sort = origSort
    Array.prototype.toSorted = origToSorted
  }
}

const N = 20000

// ---------- correctness against the oracle (moderate size) ----------
test('parseLog matches the reference for default and custom levels, CRLF, blanks and junk', () => {
  const events = makeEvents(1200, { seed: 3 })
  const lines = events.map(toLine)
  lines.splice(10, 0, '', 'junk', '2024-13-99T00:00:00Z INFO a 1ms x', '   ')
  lines.splice(50, 0, '2024-03-01T00:00:00.000Z NOTICE api 12ms custom level')
  const text = lines.join('\r\n')
  assert.deepEqual(parseLog(text), oracle.parseLog(text, ['DEBUG', 'INFO', 'WARN', 'ERROR']))
  const custom = ['NOTICE', 'ERROR']
  assert.deepEqual(parseLog(text, { levels: custom }), oracle.parseLog(text, custom))
  assert.equal(parseLine('2024-03-01T00:00:00.000Z NOTICE api 12ms hi', ['NOTICE'])?.level, 'NOTICE')
  assert.equal(parseLine('2024-03-01T00:00:00.000Z INFO api 12ms hi', ['NOTICE']), null)
})

test('dedupeEvents matches the reference with the default and a custom key', () => {
  const events = makeEvents(1500, { services: 5, messages: 6, seed: 11 })
  const defaultKey = (e) => `${e.ts}|${e.service}|${e.message}`
  assert.deepEqual(dedupeEvents(events), oracle.dedupe(events, defaultKey))
  const byMessage = (e) => e.message.toUpperCase()
  const got = dedupeEvents(events, byMessage)
  assert.equal(got.length, 6)
  assert.deepEqual(got, oracle.dedupe(events, byMessage))
  got.forEach((e, i) => assert.equal(e, oracle.dedupe(events, byMessage)[i]))
})

test('rollingErrorRate matches the reference, including ties and tiny or huge windows', () => {
  const events = makeEvents(1500, { seed: 5 })
  for (const w of [0, 1, 150, 5000, 1e9]) assert.deepEqual(rollingErrorRate(events, w), oracle.window(events, w), `window ${w}`)
  const allSame = Array.from({ length: 50 }, (_, i) => ({ ts: 1000, level: i % 5 === 0 ? 'ERROR' : 'INFO', service: 's', latencyMs: 1, message: '' }))
  assert.deepEqual(rollingErrorRate(allSame, 10), oracle.window(allSame, 10))
  assert.deepEqual(rollingErrorRate([], 10), [])
})

test('serviceTable matches the reference', () => {
  const events = makeEvents(2000, { services: 300, seed: 13 })
  assert.deepEqual(serviceTable(events), oracle.services(events))
  assert.deepEqual(serviceTable([]), [])
})

test('percentile and latencySummary match the reference', () => {
  const events = makeEvents(1000, { seed: 17 })
  const ps = Array.from({ length: 100 }, (_, i) => i)
  assert.deepEqual(latencySummary(events, ps), oracle.latency(events, ps))
  assert.deepEqual(latencySummary(events), oracle.latency(events, [50, 90, 99]))
  assert.deepEqual(latencySummary([], [50]), { p50: 0 })
  const values = events.map((e) => e.latencyMs)
  const before = [...values]
  assert.equal(percentile(values, 95), oracle.percentile(values, 95))
  assert.deepEqual(values, before, 'percentile must not reorder its input')
})

test('buildReport matches the reference pipeline end to end', () => {
  const events = makeEvents(1800, { services: 40, messages: 25, seed: 23 })
  // shuffle a few lines out of order and add duplicates and junk
  const lines = events.map(toLine)
  lines.push(lines[3], lines[400], 'noise', '')
  const tmp = lines[10]
  lines[10] = lines[900]
  lines[900] = tmp
  const text = lines.join('\n')
  const options = { windowMs: 2500, percentiles: [10, 50, 95, 100] }
  const report = buildReport(text, options)

  const { events: parsed, skipped } = oracle.parseLog(text, LEVELS)
  const key = (e) => `${e.ts}|${e.service}|${e.message}`
  const unique = oracle.dedupe(parsed, key)
  const ordered = unique.map((e, i) => [e, i]).sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1]).map((x) => x[0])
  const windows = oracle.window(ordered, options.windowMs)
  const expected = {
    total: parsed.length,
    unique: unique.length,
    skipped,
    services: oracle.services(unique),
    latency: oracle.latency(unique, options.percentiles),
    peakErrorRate: windows.reduce((p, w) => Math.max(p, w.rate), 0),
  }
  assert.deepEqual(report, expected)
  assert.deepEqual(buildReport(text), buildReport(text, { windowMs: 60000, percentiles: [50, 90, 99] }))
})

// ---------- operation budgets at scale (no wall-clock timing) ----------
test(`parseLog builds its pattern a bounded number of times for ${N} lines`, () => {
  const text = makeEvents(N, { seed: 31 }).map(toLine).join('\n')
  const { result, counts } = withCounters(() => parseLog(text, { levels: LEVELS }), { limit: 200 })
  assert.equal(result.events.length, N)
  assert.equal(result.skipped, 0)
  assert.ok(counts.regexp <= 200, `RegExp constructed ${counts.regexp} times`)
  assert.ok(counts.concat <= 200, `Array.prototype.concat called ${counts.concat} times`)
})

test('a hoisted default pattern must not break custom levels at scale', () => {
  const lines = []
  for (let i = 0; i < 3000; i++) lines.push(`2024-03-01T00:00:${String(i % 60).padStart(2, '0')}.000Z ${i % 2 ? 'NOTICE' : 'ALERT'} api ${i}ms m${i}`)
  const { result } = withCounters(() => parseLog(lines.join('\n'), { levels: ['NOTICE', 'ALERT'] }), { limit: 200 })
  assert.equal(result.events.length, 3000)
  assert.equal(parseLog(lines.join('\n')).events.length, 0)
})

test(`dedupeEvents calls keyOf a linear number of times for ${N} events`, () => {
  const r = rng(41)
  const events = Array.from({ length: N }, () => ({
    ts: 1_700_000_000_000 + Math.floor(r() * 50),
    level: 'INFO',
    service: `svc-${Math.floor(r() * 20)}`,
    latencyMs: 5,
    message: `m${Math.floor(r() * 20)}`,
  }))
  let calls = 0
  const keyOf = (e) => {
    if (++calls > 3 * N) throw new BudgetExceeded(`keyOf called more than ${3 * N} times`)
    return `${e.ts}|${e.service}|${e.message}`
  }
  const got = dedupeEvents(events, keyOf)
  assert.ok(calls <= 3 * N, `keyOf called ${calls} times`)
  const seen = new Set()
  const expected = events.filter((e) => {
    const k = `${e.ts}|${e.service}|${e.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  assert.ok(expected.length < N && expected.length > 1000, 'fixture data should contain many but not only duplicates')
  assert.equal(got.length, expected.length)
  assert.ok(got.every((e, i) => e === expected[i]))
})

test(`rollingErrorRate reads each event a bounded number of times for ${N} events`, () => {
  const raw = makeEvents(N, { seed: 51 })
  const { proxies, state } = countedEvents(raw, 20 * N)
  const got = rollingErrorRate(proxies, 3000)
  assert.ok(state.reads <= 20 * N, `${state.reads} reads`)
  assert.equal(got.length, N)
  // spot-check against a direct computation on a sample of positions
  for (const i of [0, 1, 777, 5000, 12345, N - 1]) {
    const e = raw[i]
    let total = 0
    let errors = 0
    for (const o of raw) if (o.ts <= e.ts && o.ts > e.ts - 3000) (total++, o.level === 'ERROR' && errors++)
    assert.deepEqual(got[i], { ts: e.ts, total, errors, rate: total === 0 ? 0 : errors / total })
  }
})

test(`serviceTable reads each event a bounded number of times with many services (${N} events)`, () => {
  const raw = makeEvents(N, { services: 4000, seed: 61 })
  const { proxies, state } = countedEvents(raw, 20 * N)
  const got = serviceTable(proxies)
  assert.ok(state.reads <= 20 * N, `${state.reads} reads`)
  assert.deepEqual(got, oracle.services(raw))
})

test(`latencySummary does not sort once per percentile (${N} events, 99 percentiles)`, () => {
  const raw = makeEvents(N, { seed: 71 })
  const ps = Array.from({ length: 99 }, (_, i) => i + 1)
  const { proxies, state } = countedEvents(raw, 20 * N)
  const { result, counts } = withCounters(() => latencySummary(proxies, ps), { limit: 10 })
  assert.ok(state.reads <= 20 * N, `${state.reads} reads`)
  assert.ok(counts.sort <= 10, `${counts.sort} sorts`)
  assert.deepEqual(result, oracle.latency(raw, ps))
})
