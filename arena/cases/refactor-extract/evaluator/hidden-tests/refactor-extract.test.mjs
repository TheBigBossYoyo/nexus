import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createInvoice, createQuote, salesReport, taxRateFor } from '../src/index.js'
import * as pricing from '../src/pricing.js'

afterEach(() => pricing.resetRoundingFunction())

const ceilCents = (x) => Math.ceil(x * 100 - 1e-9) / 100
const floorCents = (x) => Math.floor(x * 100 + 1e-9) / 100

// ---- characterisation of existing behaviour (must be preserved exactly)
test('invoice behaviour is unchanged', () => {
  const inv = createInvoice({ customer: 'c', region: 'EU', items: [{ sku: 'screw', quantity: 3 }, { sku: 'book', quantity: 7, discountPct: 12.5 }, { sku: 'voucher', quantity: 2 }] })
  assert.deepEqual(inv.lines.map((l) => [l.net, l.tax, l.total]), [[1.01, 0.2, 1.21], [75.64, 5.29, 80.93], [50, 0, 50]])
  assert.equal(inv.subtotal, 126.65)
  assert.equal(inv.taxTotal, 5.49)
  assert.equal(inv.total, 132.14)
})

test('quote behaviour is unchanged', () => {
  const q = createQuote([{ sku: 'screw', quantity: 30 }, { sku: 'widget', quantity: 11, discountPct: 2 }, { sku: 'book', quantity: 3 }], { region: 'US' })
  assert.deepEqual(q.lines.map((l) => [l.discountPct, l.net, l.tax, l.total]), [[5, 9.55, 0.69, 10.24], [5, 208.9, 15.15, 224.05], [0, 37.05, 2.69, 39.74]])
  assert.equal(q.total, 274.03)
})

test('report behaviour is unchanged', () => {
  const r = salesReport([
    { id: 1, lines: [{ sku: 'x', quantity: 3, unitPrice: 0.335, taxRate: 0.0725 }, { sku: 'y', quantity: 7, unitPrice: 1.15, discountPct: 12.5, taxRate: 0.2 }] },
    { id: 2, lines: [{ sku: 'x', quantity: 3, unitPrice: 0.335, taxRate: 0.0725 }] },
  ])
  assert.deepEqual(r.bySku.x, { quantity: 6, net: 2.02, tax: 0.14, total: 2.16 })
  assert.deepEqual(r.bySku.y, { quantity: 7, net: 7.04, tax: 1.41, total: 8.45 })
  assert.equal(r.grandTotal, 10.61)
})

// ---- the shared module
test('computeLineTotal has the specified contract', () => {
  assert.equal(typeof pricing.computeLineTotal, 'function')
  assert.deepEqual(pricing.computeLineTotal({ quantity: 3, unitPrice: 0.335 }), { net: 1.01, tax: 0, total: 1.01 })
  assert.deepEqual(pricing.computeLineTotal({ quantity: 2, unitPrice: 19.99, taxRate: 0.2 }), { net: 39.98, tax: 8, total: 47.98 })
  assert.deepEqual(pricing.computeLineTotal({ quantity: 7, unitPrice: 12.35, discountPct: 12.5, taxRate: 0.07 }), { net: 75.64, tax: 5.29, total: 80.93 })
})

test('rounding seam: setRoundingFunction is observed and resettable', () => {
  const before = pricing.computeLineTotal({ quantity: 3, unitPrice: 0.335, taxRate: 0.2 })
  pricing.setRoundingFunction(ceilCents)
  const during = pricing.computeLineTotal({ quantity: 3, unitPrice: 0.335, taxRate: 0.2 })
  assert.notDeepEqual(during, before)
  pricing.resetRoundingFunction()
  assert.deepEqual(pricing.computeLineTotal({ quantity: 3, unitPrice: 0.335, taxRate: 0.2 }), before)
})

// ---- every public pricing path must delegate to the shared module
for (const [name, fn] of [['ceil', ceilCents], ['floor', floorCents]]) {
  test(`createInvoice lines follow computeLineTotal (${name} rounding)`, () => {
    pricing.setRoundingFunction(fn)
    const items = [{ sku: 'screw', quantity: 3 }, { sku: 'widget', quantity: 3, discountPct: 7 }, { sku: 'book', quantity: 7, discountPct: 12.5 }]
    const inv = createInvoice({ customer: 'c', region: 'EU', items })
    const skuRate = { screw: 'standard', widget: 'standard', book: 'reduced' }
    const prices = { screw: 0.335, widget: 19.99, book: 12.35 }
    inv.lines.forEach((line, i) => {
      const expected = pricing.computeLineTotal({ quantity: items[i].quantity, unitPrice: prices[items[i].sku], discountPct: items[i].discountPct ?? 0, taxRate: taxRateFor(skuRate[items[i].sku], 'EU') })
      assert.deepEqual({ net: line.net, tax: line.tax, total: line.total }, expected, items[i].sku)
    })
  })

  test(`createQuote lines follow computeLineTotal (${name} rounding)`, () => {
    pricing.setRoundingFunction(fn)
    const items = [{ sku: 'screw', quantity: 30 }, { sku: 'widget', quantity: 3, discountPct: 7 }, { sku: 'book', quantity: 11 }]
    const q = createQuote(items, { region: 'EU' })
    const prices = { screw: 0.335, widget: 19.99, book: 12.35 }
    const cat = { screw: 'standard', widget: 'standard', book: 'reduced' }
    q.lines.forEach((line, i) => {
      const it = items[i]
      const discountPct = Math.max(it.discountPct ?? 0, it.quantity >= 10 ? 5 : 0)
      const expected = pricing.computeLineTotal({ quantity: it.quantity, unitPrice: prices[it.sku], discountPct, taxRate: taxRateFor(cat[it.sku], 'EU') })
      assert.deepEqual({ net: line.net, tax: line.tax, total: line.total }, expected, it.sku)
    })
  })

  test(`salesReport lines follow computeLineTotal (${name} rounding)`, () => {
    pricing.setRoundingFunction(fn)
    for (const l of [{ sku: 'x', quantity: 3, unitPrice: 0.335, taxRate: 0.0725 }, { sku: 'y', quantity: 7, unitPrice: 1.15, discountPct: 12.5, taxRate: 0.2 }]) {
      const r = salesReport([{ id: 1, lines: [l] }])
      const expected = pricing.computeLineTotal({ quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct ?? 0, taxRate: l.taxRate })
      const e = r.bySku[l.sku]
      assert.deepEqual({ net: e.net, tax: e.tax, total: e.total }, expected, l.sku)
    }
  })
}

test('all three public functions call the injected rounding function', () => {
  for (const run of [
    () => createInvoice({ customer: 'c', items: [{ sku: 'widget', quantity: 1 }] }),
    () => createQuote([{ sku: 'widget', quantity: 1 }]),
    () => salesReport([{ id: 1, lines: [{ sku: 'a', quantity: 1, unitPrice: 2, taxRate: 0.1 }] }]),
  ]) {
    let calls = 0
    pricing.setRoundingFunction((x) => { calls++; return Math.round(x * 100) / 100 })
    run()
    assert.ok(calls >= 3, `expected line amounts to be rounded through the seam, got ${calls} calls`)
    pricing.resetRoundingFunction()
  }
})
