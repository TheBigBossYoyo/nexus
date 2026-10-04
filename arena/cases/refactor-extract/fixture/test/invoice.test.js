import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInvoice } from '../src/index.js'

test('invoice computes line and document totals', () => {
  const inv = createInvoice({ customer: 'ACME', region: 'EU', items: [{ sku: 'widget', quantity: 2 }, { sku: 'book', quantity: 1, discountPct: 10 }] })
  assert.equal(inv.lines[0].net, 39.98)
  assert.equal(inv.lines[0].tax, 8)
  assert.equal(inv.lines[0].total, 47.98)
  assert.equal(inv.lines[1].net, 11.12)
  assert.equal(inv.subtotal, 51.1)
})

test('invoice rejects unknown sku and bad quantity', () => {
  assert.throws(() => createInvoice({ customer: 'x', items: [{ sku: 'nope', quantity: 1 }] }), /Unknown SKU/)
  assert.throws(() => createInvoice({ customer: 'x', items: [{ sku: 'widget', quantity: 0 }] }), /quantity/)
})
