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

// ---------- scaling, measured behaviourally ----------
// Each operation is timed at n and 8n items in-process. Linear code takes about 8x as long and n log n code
// about 10x; quadratic code takes about 64x. The threshold (24x) sits far from both, so neither a correct
// implementation on a busy machine nor a quadratic one on an idle machine lands on the wrong side.
//
// A single call on the small input lasts well under a millisecond, which a timer cannot measure reliably.
// So every measurement repeats the call until a batch has run for at least BATCH_MS and divides; and the
// best of several batches is kept, because other load on the machine can only make a batch slower, never
// faster. Nothing here counts calls of built-ins, so any linear or n log n implementation is accepted.
const SMALL = 2000
const LARGE = 16000
const MAX_RATIO = 24
const BATCH_MS = 40
const BATCHES = 7
const GIVE_UP_MS = 4000

function timePerCall(fn, what) {
  let t0 = performance.now()
  fn() // warm-up, and a guard against an input that is simply far too slow
  const first = performance.now() - t0
  assert.ok(first < GIVE_UP_MS, `${what} took ${first.toFixed(0)} ms for a single run: far too slow for this input size`)
  let best = Infinity
  for (let batch = 0; batch < BATCHES; batch++) {
    let calls = 0
    t0 = performance.now()
    let elapsed = 0
    do {
      fn()
      calls++
      elapsed = performance.now() - t0
    } while (elapsed < BATCH_MS)
    best = Math.min(best, elapsed / calls)
    if (elapsed > 1500) break // one call is already long: more batches add nothing
  }
  return best
}

function assertScalesLinearly(name, makeInput, run) {
  const small = makeInput(SMALL)
  const large = makeInput(LARGE)
  const ts = timePerCall(() => run(small), `${name} (${SMALL} items)`)
  const tl = timePerCall(() => run(large), `${name} (${LARGE} items)`)
  const ratio = tl / ts
  assert.ok(
    ratio < MAX_RATIO,
    `${name}: ${LARGE} items took ${tl.toFixed(2)} ms against ${ts.toFixed(3)} ms for ${SMALL} (ratio ${ratio.toFixed(1)}; about 8 is linear, about 64 is quadratic)`,
  )
}

test('parseLog scales linearly with the number of lines', () => {
  assertScalesLinearly('parseLog', (n) => makeEvents(n, { seed: 31 }).map(toLine).join('\n'), (text) => parseLog(text))
})

test('a hoisted default pattern must not break custom levels', () => {
  const lines = []
  for (let i = 0; i < 3000; i++) lines.push(`2024-03-01T00:00:${String(i % 60).padStart(2, '0')}.000Z ${i % 2 ? 'NOTICE' : 'ALERT'} api ${i}ms m${i}`)
  assert.equal(parseLog(lines.join('\n'), { levels: ['NOTICE', 'ALERT'] }).events.length, 3000)
  assert.equal(parseLog(lines.join('\n')).events.length, 0)
})

test('dedupeEvents scales linearly and calls keyOf a bounded number of times', () => {
  const unique = (n) => makeEvents(n, { services: 50, messages: 1e9, seed: 41 })
  assertScalesLinearly('dedupeEvents', unique, (events) => dedupeEvents(events))
  const events = unique(LARGE)
  let calls = 0
  const keyOf = (e) => (calls++, `${e.ts}|${e.service}|${e.message}`)
  const got = dedupeEvents(events, keyOf)
  assert.ok(calls <= 3 * LARGE, `keyOf was called ${calls} times for ${LARGE} events`)
  const seen = new Set()
  const expected = events.filter((e) => {
    const k = `${e.ts}|${e.service}|${e.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  assert.equal(got.length, expected.length)
  assert.ok(got.every((e, i) => e === expected[i]))
})

test('rollingErrorRate scales linearly (or n log n) with the number of events', () => {
  assertScalesLinearly('rollingErrorRate', (n) => makeEvents(n, { seed: 51 }), (events) => rollingErrorRate(events, 3000))
  const raw = makeEvents(LARGE, { seed: 52 })
  const got = rollingErrorRate(raw, 3000)
  assert.equal(got.length, LARGE)
  for (const i of [0, 1, 777, 5000, 9999, LARGE - 1]) {
    const e = raw[i]
    let total = 0
    let errors = 0
    for (const o of raw) if (o.ts <= e.ts && o.ts > e.ts - 3000) (total++, o.level === 'ERROR' && errors++)
    assert.deepEqual(got[i], { ts: e.ts, total, errors, rate: total === 0 ? 0 : errors / total })
  }
})

test('serviceTable scales linearly with many distinct services', () => {
  assertScalesLinearly('serviceTable', (n) => makeEvents(n, { services: Math.floor(n / 4), seed: 61 }), (events) => serviceTable(events))
  const raw = makeEvents(LARGE, { services: 3000, seed: 62 })
  assert.deepEqual(serviceTable(raw), oracle.services(raw))
})

test('buildReport scales linearly end to end', () => {
  assertScalesLinearly('buildReport', (n) => makeEvents(n, { services: n / 4, messages: 1e9, seed: 71 }).map(toLine).join('\n'), (text) => buildReport(text))
})
