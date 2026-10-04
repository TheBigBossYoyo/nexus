import { test } from 'node:test'
import assert from 'node:assert/strict'
import { salesReport } from '../src/index.js'

test('report aggregates per sku', () => {
  const r = salesReport([
    { id: 1, lines: [{ sku: 'a', quantity: 2, unitPrice: 10, taxRate: 0.1 }] },
    { id: 2, lines: [{ sku: 'a', quantity: 1, unitPrice: 10, taxRate: 0.1 }, { sku: 'b', quantity: 1, unitPrice: 4, discountPct: 50 }] },
  ])
  assert.deepEqual(r.bySku.a, { quantity: 3, net: 30, tax: 3, total: 33 })
  assert.deepEqual(r.bySku.b, { quantity: 1, net: 2, tax: 0, total: 2 })
  assert.equal(r.grandTotal, 35)
})
