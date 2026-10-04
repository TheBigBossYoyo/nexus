import test from 'node:test'
import assert from 'node:assert/strict'
import { Catalog, Inventory, priceOrder, renderInvoice, processOrder, mergeLines, formatCents, toCents } from '../src/index.js'

const catalog = () => new Catalog({ widget: 2.5, gadget: 10, gizmo: 0.99 })

test('money helpers round trip', () => {
  assert.equal(toCents(19.99), 1999)
  assert.equal(formatCents(1999), '$19.99')
  assert.equal(formatCents(5), '$0.05')
  assert.throws(() => toCents(-1), RangeError)
})

test('priceOrder totals lines and tax', () => {
  const priced = priceOrder({ id: 'o1', customer: 'Ada', lines: [{ sku: 'widget', qty: 2 }, { sku: 'gadget', qty: 1 }] }, catalog())
  assert.equal(priced.subtotalCents, 1500)
  assert.equal(priced.taxCents, 124)
  assert.equal(priced.totalCents, 1624)
})

test('priceOrder merges duplicate skus (single call)', () => {
  const priced = priceOrder({ id: 'o2', customer: 'Bo', lines: [{ sku: 'widget', qty: 1 }, { sku: ' WIDGET ', qty: 2 }] }, catalog())
  assert.deepEqual(priced.lines, [{ sku: 'WIDGET', qty: 3, unitCents: 250, totalCents: 750 }])
})

test('priceOrder rejects unknown skus and bad quantities', () => {
  assert.throws(() => priceOrder({ id: 'o3', customer: 'C', lines: [{ sku: 'nope', qty: 1 }] }, catalog()), RangeError)
  assert.throws(() => priceOrder({ id: 'o3', customer: 'C', lines: [{ sku: 'widget', qty: 0 }] }, catalog()), RangeError)
})

test('mergeLines keeps first-seen order', () => {
  const merged = mergeLines([{ sku: 'b', qty: 1 }, { sku: 'a', qty: 1 }, { sku: 'B', qty: 4 }])
  assert.deepEqual(merged.map((l) => [l.sku, l.qty]), [['B', 5], ['A', 1]])
})

test('inventory reserves all or nothing', () => {
  const inv = new Inventory({ widget: 5, gadget: 1 })
  assert.throws(() => inv.reserve({ lines: [{ sku: 'widget', qty: 2 }, { sku: 'gadget', qty: 2 }] }), RangeError)
  assert.equal(inv.available('widget'), 5)
  inv.reserve({ lines: [{ sku: 'widget', qty: 2 }] })
  assert.equal(inv.available('widget'), 3)
})

test('renderInvoice lists lines and totals', () => {
  const priced = priceOrder({ id: 'o4', customer: 'Dee', lines: [{ sku: 'gizmo', qty: 3 }] }, catalog())
  const text = renderInvoice(priced)
  assert.match(text, /Invoice for order o4 \(Dee\)/)
  assert.match(text, /GIZMO\s+3 x\s+\$0\.99 =\s+\$2\.97/)
  assert.match(text, /Total: \$3\.22/)
})

test('processOrder runs the pipeline for distinct lines', () => {
  const inv = new Inventory({ widget: 10, gadget: 10 })
  const result = processOrder({ id: 'o5', customer: 'Eve', lines: [{ sku: 'widget', qty: 4 }, { sku: 'gadget', qty: 1 }] }, catalog(), inv)
  assert.equal(result.priced.subtotalCents, 2000)
  assert.deepEqual(result.reserved, [{ sku: 'WIDGET', qty: 4 }, { sku: 'GADGET', qty: 1 }])
  assert.equal(inv.available('widget'), 6)
})
