import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseField, parseCron, runsPerDay, matches, nextRun, upcoming, CronError } from '../src/index.js'

const minute = { name: 'minute', min: 0, max: 59 }
const dom = { name: 'day-of-month', min: 1, max: 31 }
const month = { name: 'month', min: 1, max: 12, names: { JAN: 1, FEB: 2, MAR: 3 } }
const iso = (d) => (d ? d.toISOString() : null)
const at = (s) => new Date(s)

test('parseField: boundaries of the allowed range are accepted', () => {
  assert.deepEqual(parseField('0', minute), [0])
  assert.deepEqual(parseField('59', minute), [59])
  assert.deepEqual(parseField('1', dom), [1])
  assert.deepEqual(parseField('31', dom), [31])
  assert.deepEqual(parseField('0-59', minute).length, 60)
})

test('parseField: values outside the range are rejected', () => {
  assert.throws(() => parseField('60', minute), CronError)
  assert.throws(() => parseField('0', dom), CronError)
  assert.throws(() => parseField('32', dom), CronError)
  assert.throws(() => parseField('55-60', minute), CronError)
  assert.throws(() => parseField('0-5', dom), CronError)
})

test('parseField: single-element and reversed ranges', () => {
  assert.deepEqual(parseField('5-5', minute), [5])
  assert.throws(() => parseField('9-3', minute), CronError)
  assert.throws(() => parseField('1-2-3', minute), CronError)
})

test('parseField: steps', () => {
  assert.deepEqual(parseField('*/1', { name: 'x', min: 0, max: 3 }), [0, 1, 2, 3])
  assert.deepEqual(parseField('*/15', minute), [0, 15, 30, 45])
  assert.deepEqual(parseField('10-30/10', minute), [10, 20, 30])
  assert.deepEqual(parseField('10-31/10', minute), [10, 20, 30])
  assert.deepEqual(parseField('10/15', minute), [10, 25, 40, 55])
  assert.deepEqual(parseField('*/7', minute), [0, 7, 14, 21, 28, 35, 42, 49, 56])
  assert.throws(() => parseField('*/0', minute), CronError)
  assert.throws(() => parseField('*/x', minute), CronError)
  assert.throws(() => parseField('1/2/3', minute), CronError)
})

test('parseField: lists are merged, deduplicated and sorted', () => {
  assert.deepEqual(parseField('30,1-3,2,*/30', minute), [0, 1, 2, 3, 30])
  assert.throws(() => parseField('1,,2', minute), CronError)
  assert.throws(() => parseField('', minute), CronError)
  assert.throws(() => parseField('1,', minute), CronError)
})

test('parseField: names are case-insensitive and rejected when unknown', () => {
  assert.deepEqual(parseField('JAN', month), [1])
  assert.deepEqual(parseField('jan', month), [1])
  assert.deepEqual(parseField('Feb-mar', month), [2, 3])
  assert.throws(() => parseField('xyz', month), CronError)
  assert.throws(() => parseField('JAN', minute), CronError)
})

test('parseField: malformed numbers', () => {
  for (const bad of ['-1', '1.5', '+3', '0x10', ' 5', '5a']) assert.throws(() => parseField(bad, minute), CronError, bad)
})

test('parseCron: field count, whitespace and type', () => {
  assert.throws(() => parseCron('* * * *'), CronError)
  assert.throws(() => parseCron('* * * * * *'), CronError)
  assert.throws(() => parseCron(''), CronError)
  assert.throws(() => parseCron(5), CronError)
  assert.deepEqual(parseCron('  5   4  *  *  *  ').minute, [5])
  assert.throws(() => parseCron('* * * 13 *'), CronError)
  assert.throws(() => parseCron('* 24 * * *'), CronError)
})

test('parseCron: day-of-week 7 is Sunday', () => {
  assert.deepEqual(parseCron('0 0 * * 7').dow, [0])
  assert.deepEqual(parseCron('0 0 * * 0,7').dow, [0])
  assert.deepEqual(parseCron('0 0 * * 5-7').dow, [0, 5, 6])
  assert.deepEqual(parseCron('0 0 * * SUN').dow, [0])
  assert.throws(() => parseCron('0 0 * * 8'), CronError)
})

test('parseCron: aliases', () => {
  assert.deepEqual(parseCron('@weekly'), parseCron('0 0 * * 0'))
  assert.deepEqual(parseCron('@WEEKLY'), parseCron('0 0 * * 0'))
  assert.deepEqual(parseCron('@daily'), parseCron('0 0 * * *'))
  assert.deepEqual(parseCron('@midnight'), parseCron('0 0 * * *'))
  assert.deepEqual(parseCron('@hourly'), parseCron('0 * * * *'))
  assert.deepEqual(parseCron('@monthly'), parseCron('0 0 1 * *'))
  assert.deepEqual(parseCron('@yearly'), parseCron('0 0 1 1 *'))
  assert.deepEqual(parseCron('@annually'), parseCron('0 0 1 1 *'))
  assert.throws(() => parseCron('@sometimes'), CronError)
})

test('parseCron: wildcard flags for the day fields', () => {
  assert.equal(parseCron('0 0 * * MON').domAny, true)
  assert.equal(parseCron('0 0 */2 * MON').domAny, true)
  assert.equal(parseCron('0 0 1 * *').domAny, false)
  assert.equal(parseCron('0 0 1 * */2').dowAny, true)
  assert.equal(parseCron('0 0 1 * 1').dowAny, false)
})

test('runsPerDay multiplies minutes by hours', () => {
  assert.equal(runsPerDay(parseCron('* * * * *')), 1440)
  assert.equal(runsPerDay(parseCron('0,30 9-17 * * *')), 18)
  assert.equal(runsPerDay(parseCron('5 4 * * *')), 1)
})

test('matches: every time field must agree', () => {
  const s = parseCron('30 2 5 3 *')
  assert.equal(matches(s, at('2024-03-05T02:30:00Z')), true)
  assert.equal(matches(s, at('2024-03-05T02:30:59Z')), true)
  assert.equal(matches(s, at('2024-03-05T02:31:00Z')), false)
  assert.equal(matches(s, at('2024-03-05T03:30:00Z')), false)
  assert.equal(matches(s, at('2024-03-06T02:30:00Z')), false)
  assert.equal(matches(s, at('2024-04-05T02:30:00Z')), false)
})

test('matches: day-of-month OR day-of-week when both are restricted', () => {
  const s = parseCron('0 0 13 * FRI')
  assert.equal(matches(s, at('2024-09-13T00:00:00Z')), true) // Friday the 13th
  assert.equal(matches(s, at('2024-09-06T00:00:00Z')), true) // Friday, not the 13th
  assert.equal(matches(s, at('2024-10-13T00:00:00Z')), true) // the 13th, a Sunday
  assert.equal(matches(s, at('2024-09-12T00:00:00Z')), false)
})

test('matches: a starred day field leaves the other one in charge', () => {
  const mondays = parseCron('0 0 * * MON')
  assert.equal(matches(mondays, at('2024-03-04T00:00:00Z')), true)
  assert.equal(matches(mondays, at('2024-03-05T00:00:00Z')), false)
  const oddMondays = parseCron('0 0 */2 * MON')
  assert.equal(matches(oddMondays, at('2024-03-04T00:00:00Z')), false) // Monday, even day
  assert.equal(matches(oddMondays, at('2024-03-03T00:00:00Z')), false) // odd day, Sunday
  assert.equal(matches(oddMondays, at('2024-03-11T00:00:00Z')), true) // odd Monday
  const first = parseCron('0 0 1 * *')
  assert.equal(matches(first, at('2024-05-01T00:00:00Z')), true)
  assert.equal(matches(first, at('2024-05-02T00:00:00Z')), false)
})

test('matches: Sunday written as 0 and as 7', () => {
  assert.equal(matches(parseCron('0 0 * * 7'), at('2024-03-03T00:00:00Z')), true)
  assert.equal(matches(parseCron('0 0 * * 7'), at('2024-03-02T00:00:00Z')), false)
  assert.equal(matches(parseCron('0 0 * * 0'), at('2024-03-03T00:00:00Z')), true)
})

test('nextRun is strictly after the starting instant', () => {
  const s = parseCron('30 2 * * *')
  assert.equal(iso(nextRun(s, at('2024-03-05T02:30:00Z'))), '2024-03-06T02:30:00.000Z')
  assert.equal(iso(nextRun(s, at('2024-03-05T02:29:59.999Z'))), '2024-03-05T02:30:00.000Z')
  assert.equal(iso(nextRun(s, at('2024-03-05T02:30:00.001Z'))), '2024-03-06T02:30:00.000Z')
  assert.equal(iso(nextRun(parseCron('* * * * *'), at('2024-03-05T02:30:30Z'))), '2024-03-05T02:31:00.000Z')
})

test('nextRun crosses hour, day, month and year boundaries', () => {
  assert.equal(iso(nextRun(parseCron('15 * * * *'), at('2024-03-05T10:20:00Z'))), '2024-03-05T11:15:00.000Z')
  assert.equal(iso(nextRun(parseCron('0 0 * * *'), at('2024-03-05T10:20:00Z'))), '2024-03-06T00:00:00.000Z')
  assert.equal(iso(nextRun(parseCron('0 0 1 * *'), at('2024-01-15T00:00:00Z'))), '2024-02-01T00:00:00.000Z')
  assert.equal(iso(nextRun(parseCron('0 0 1 3 *'), at('2024-01-15T00:00:00Z'))), '2024-03-01T00:00:00.000Z')
  assert.equal(iso(nextRun(parseCron('0 0 1 3 *'), at('2024-03-01T00:00:00Z'))), '2025-03-01T00:00:00.000Z')
  assert.equal(iso(nextRun(parseCron('59 23 31 12 *'), at('2024-12-31T23:58:00Z'))), '2024-12-31T23:59:00.000Z')
  assert.equal(iso(nextRun(parseCron('0 0 1 1 *'), at('2024-12-31T23:59:59Z'))), '2025-01-01T00:00:00.000Z')
})

test('nextRun with weekdays and the day-of-month/day-of-week union', () => {
  assert.equal(iso(nextRun(parseCron('*/15 9-17 * * MON-FRI'), at('2024-03-01T17:50:00Z'))), '2024-03-04T09:00:00.000Z')
  assert.equal(iso(nextRun(parseCron('0 12 13 * FRI'), at('2024-09-07T00:00:00Z'))), '2024-09-13T12:00:00.000Z')
  assert.equal(iso(nextRun(parseCron('0 12 13 * FRI'), at('2024-09-14T00:00:00Z'))), '2024-09-20T12:00:00.000Z')
})

test('nextRun finds leap days and gives up on impossible dates', () => {
  assert.equal(iso(nextRun(parseCron('0 0 29 2 *'), at('2025-03-01T00:00:00Z'))), '2028-02-29T00:00:00.000Z')
  assert.equal(nextRun(parseCron('0 0 30 2 *'), at('2024-01-01T00:00:00Z')), null)
  assert.equal(iso(nextRun(parseCron('0 0 29 2 *'), at('2025-03-01T00:00:00Z'), { limitYears: 1 })), null)
})

test('upcoming lists runs in order and stops when the schedule runs out', () => {
  const runs = upcoming(parseCron('0 */6 * * *'), at('2024-03-05T01:00:00Z'), 5).map(iso)
  assert.deepEqual(runs, [
    '2024-03-05T06:00:00.000Z',
    '2024-03-05T12:00:00.000Z',
    '2024-03-05T18:00:00.000Z',
    '2024-03-06T00:00:00.000Z',
    '2024-03-06T06:00:00.000Z',
  ])
  assert.deepEqual(upcoming(parseCron('0 0 * * *'), at('2024-03-05T00:00:00Z'), 0), [])
  assert.equal(upcoming(parseCron('0 0 * * *'), at('2024-03-05T00:00:00Z'), 1).length, 1)
  assert.deepEqual(upcoming(parseCron('0 0 30 2 *'), at('2024-01-01T00:00:00Z'), 3), [])
})
