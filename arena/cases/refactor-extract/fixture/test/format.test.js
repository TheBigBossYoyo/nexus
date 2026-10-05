import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMoney, taxRateFor } from '../src/index.js'

test('formatMoney groups thousands', () => {
  assert.equal(formatMoney(1234567.5), '$1,234,567.50')
  assert.equal(formatMoney(-3), '-$3.00')
})

test('taxRateFor looks up rates', () => {
  assert.equal(taxRateFor('standard', 'EU'), 0.2)
  assert.throws(() => taxRateFor('standard', 'MARS'), /region/)
})
