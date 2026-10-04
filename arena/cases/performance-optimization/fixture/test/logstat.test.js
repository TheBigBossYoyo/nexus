import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLine,
  parseLog,
  dedupeEvents,
  rollingErrorRate,
  serviceTable,
  percentile,
  latencySummary,
  buildReport,
  formatReport,
} from '../src/index.js'

const LOG = [
  '2024-03-01T12:00:00.000Z INFO checkout 120ms order created',
  '2024-03-01T12:00:10.000Z ERROR checkout 900ms payment failed',
  '',
  'garbage line',
  '2024-03-01T12:00:10.000Z ERROR checkout 900ms payment failed',
  '2024-03-01T12:00:20.000Z WARN search 45ms slow query',
  '2024-03-01T12:02:00.000Z INFO search 30ms',
].join('\n')

test('parseLine reads every field', () => {
  assert.deepEqual(parseLine('2024-03-01T12:00:00.000Z WARN checkout 183ms retrying payment'), {
    ts: Date.parse('2024-03-01T12:00:00.000Z'),
    level: 'WARN',
    service: 'checkout',
    latencyMs: 183,
    message: 'retrying payment',
  })
  assert.equal(parseLine('2024-03-01T12:00:00.000Z TRACE checkout 1ms x'), null)
  assert.equal(parseLine('not-a-date INFO a 1ms'), null)
})

test('parseLine honours custom levels', () => {
  assert.equal(parseLine('2024-03-01T12:00:00.000Z NOTICE api 5ms hi', ['NOTICE', 'ALERT'])?.level, 'NOTICE')
  assert.equal(parseLine('2024-03-01T12:00:00.000Z INFO api 5ms hi', ['NOTICE', 'ALERT']), null)
})

test('parseLog skips blanks, counts malformed lines and handles CRLF', () => {
  const { events, skipped } = parseLog(LOG.replace(/\n/g, '\r\n'))
  assert.equal(events.length, 5)
  assert.equal(skipped, 1)
})

test('dedupeEvents keeps the first of every key in order', () => {
  const { events } = parseLog(LOG)
  const unique = dedupeEvents(events)
  assert.equal(unique.length, 4)
  assert.deepEqual(
    unique.map((e) => e.service),
    ['checkout', 'checkout', 'search', 'search'],
  )
  const byService = dedupeEvents(events, (e) => e.service)
  assert.equal(byService.length, 2)
  assert.equal(byService[0], events[0])
})

test('rollingErrorRate counts the window (ts - w, ts] including ties', () => {
  const ev = (ts, level) => ({ ts, level, service: 's', latencyMs: 1, message: '' })
  const rows = rollingErrorRate([ev(0, 'INFO'), ev(10, 'ERROR'), ev(10, 'INFO'), ev(25, 'ERROR')], 15)
  assert.deepEqual(
    rows.map((r) => [r.total, r.errors]),
    [
      [1, 0],
      [3, 1],
      [3, 1],
      [1, 1],
    ],
  )
  assert.deepEqual(rollingErrorRate([ev(5, 'ERROR')], 0), [{ ts: 5, total: 0, errors: 0, rate: 0 }])
})

test('serviceTable orders by count then name', () => {
  const { events } = parseLog(LOG)
  const rows = serviceTable(events)
  assert.deepEqual(
    rows.map((r) => [r.service, r.count, r.errors, r.maxLatencyMs]),
    [
      ['checkout', 3, 2, 900],
      ['search', 2, 0, 45],
    ],
  )
  assert.equal(rows[1].avgLatencyMs, 37.5)
})

test('percentile is nearest rank', () => {
  assert.equal(percentile([], 50), 0)
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3)
  assert.equal(percentile([5, 1, 3, 2, 4], 100), 5)
  assert.equal(percentile([5, 1, 3, 2, 4], 0), 1)
  assert.deepEqual(latencySummary([{ latencyMs: 10 }, { latencyMs: 20 }], [50, 99]), { p50: 10, p99: 20 })
})

test('buildReport and formatReport', () => {
  const report = buildReport(LOG, { windowMs: 30000 })
  assert.equal(report.total, 5)
  assert.equal(report.unique, 4)
  assert.equal(report.skipped, 1)
  assert.equal(report.services[0].service, 'checkout')
  assert.ok(report.peakErrorRate > 0)
  const text = formatReport(report)
  assert.match(text, /events: 5 \(4 unique, 1 skipped\)/)
  assert.match(text, /checkout count=2/)
})
