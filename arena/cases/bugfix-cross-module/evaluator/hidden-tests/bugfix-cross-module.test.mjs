import test from 'node:test'
import assert from 'node:assert/strict'
import { Catalog, Inventory, priceOrder, processOrder, mergeLines, renderInvoice } from '../src/index.js'

const catalog = () => new Catalog({ widget: 2.5, gadget: 10 })

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const duplicated = () => ({
  id: 'o1',
  customer: 'Ada',
  lines: [
    { sku: 'widget', qty: 1 },
    { sku: ' Gadget', qty: 2 },
    { sku: 'WIDGET ', qty: 2 },
  ],
})

test('pricing the same order twice gives the same totals', () => {
  const order = duplicated()
  const first = priceOrder(order, catalog())
  const second = priceOrder(order, catalog())
  assert.deepEqual(second, first)
  assert.deepEqual(first.lines.map((l) => [l.sku, l.qty]), [['WIDGET', 3], ['GADGET', 2]])
  assert.equal(first.subtotalCents, 2750)
})

test('pricing does not modify the caller order', () => {
  const order = duplicated()
  const before = structuredClone(order)
  priceOrder(order, catalog())
  assert.deepEqual(order, before)
})

test('reserving does not modify the caller order and can be repeated', () => {
  const order = duplicated()
  const before = structuredClone(order)
  const inv = new Inventory({ widget: 10, gadget: 10 })
  const reserved = inv.reserve(order)
  assert.deepEqual(order, before)
  assert.deepEqual(reserved, [{ sku: 'WIDGET', qty: 3 }, { sku: 'GADGET', qty: 2 }])
  inv.reserve(order)
  assert.equal(inv.available('widget'), 4)
  assert.equal(inv.available('gadget'), 6)
})

test('processOrder reserves exactly the merged quantities', () => {
  const order = duplicated()
  const inv = new Inventory({ widget: 3, gadget: 2 })
  const result = processOrder(order, catalog(), inv)
  assert.deepEqual(result.reserved, [{ sku: 'WIDGET', qty: 3 }, { sku: 'GADGET', qty: 2 }])
  assert.equal(inv.available('widget'), 0)
  assert.equal(inv.available('gadget'), 0)
  assert.match(result.invoice, /WIDGET\s+3 x/)
  assert.match(result.invoice, /GADGET\s+2 x/)
  assert.deepEqual(order, duplicated())
})

test('a frozen order flows through every consumer', () => {
  const order = deepFreeze(duplicated())
  const inv = new Inventory({ widget: 10, gadget: 10 })
  assert.doesNotThrow(() => priceOrder(order, catalog()))
  assert.doesNotThrow(() => inv.reserve(order))
  assert.doesNotThrow(() => processOrder(order, catalog(), inv))
  assert.doesNotThrow(() => mergeLines(order.lines))
})

test('invoice for a reprocessed order is stable', () => {
  const order = duplicated()
  const inv = new Inventory({ widget: 20, gadget: 20 })
  const a = processOrder(order, catalog(), inv)
  const b = processOrder(order, catalog(), inv)
  assert.equal(a.invoice, b.invoice)
  assert.equal(renderInvoice(priceOrder(order, catalog())), a.invoice)
})

test('mergeLines returns new line objects and keeps the input intact', () => {
  const input = [{ sku: 'a', qty: 1 }, { sku: 'A', qty: 2 }, { sku: 'b', qty: 1 }]
  const merged = mergeLines(input)
  assert.deepEqual(input, [{ sku: 'a', qty: 1 }, { sku: 'A', qty: 2 }, { sku: 'b', qty: 1 }])
  assert.deepEqual(merged.map((l) => [l.sku, l.qty]), [['A', 3], ['B', 1]])
  for (const line of merged) assert.ok(!input.includes(line))
})

test('a failed reservation leaves stock and the order untouched', () => {
  const order = duplicated()
  const inv = new Inventory({ widget: 2, gadget: 10 })
  assert.throws(() => inv.reserve(order), RangeError)
  assert.equal(inv.available('widget'), 2)
  assert.equal(inv.available('gadget'), 10)
  assert.deepEqual(order, duplicated())
})
