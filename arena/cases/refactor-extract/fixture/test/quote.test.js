import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQuote } from '../src/index.js'

test('quote applies the volume discount from 10 units', () => {
  const q = createQuote([{ sku: 'gadget', quantity: 10 }], { region: 'EU' })
  assert.equal(q.lines[0].discountPct, 5)
  assert.equal(q.lines[0].net, 52.25)
  assert.equal(q.total, q.lines[0].total)
})

test('quote keeps a larger manual discount', () => {
  const q = createQuote([{ sku: 'gadget', quantity: 10, discountPct: 20 }])
  assert.equal(q.lines[0].discountPct, 20)
})
