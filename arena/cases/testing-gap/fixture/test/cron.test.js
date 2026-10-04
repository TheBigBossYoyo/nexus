import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseField, parseCron, matches, nextRun, CronError } from '../src/index.js'

const minute = { name: 'minute', min: 0, max: 59 }

test('parseField expands wildcards, lists and ranges', () => {
  assert.equal(parseField('*', minute).length, 60)
  assert.deepEqual(parseField('1,5,3', minute), [1, 3, 5])
  assert.deepEqual(parseField('10-13', minute), [10, 11, 12, 13])
})

test('parseField expands steps', () => {
  assert.deepEqual(parseField('*/20', minute), [0, 20, 40])
})

test('parseField rejects garbage', () => {
  assert.throws(() => parseField('abc', minute), CronError)
  assert.throws(() => parseField('75', minute), CronError)
})

test('parseCron reads a simple expression', () => {
  const schedule = parseCron('30 2 * * *')
  assert.deepEqual(schedule.minute, [30])
  assert.deepEqual(schedule.hour, [2])
  assert.equal(schedule.month.length, 12)
})

test('parseCron rejects the wrong field count', () => {
  assert.throws(() => parseCron('* * * *'), CronError)
})

test('matches checks the time fields', () => {
  const schedule = parseCron('30 2 * * *')
  assert.equal(matches(schedule, new Date('2024-03-05T02:30:00Z')), true)
  assert.equal(matches(schedule, new Date('2024-03-05T02:31:00Z')), false)
})

test('nextRun finds the following minute that matches', () => {
  const schedule = parseCron('30 2 * * *')
  assert.equal(nextRun(schedule, new Date('2024-03-05T00:00:00Z')).toISOString(), '2024-03-05T02:30:00.000Z')
})
