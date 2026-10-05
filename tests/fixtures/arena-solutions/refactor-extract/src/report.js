import { computeLineTotal } from './pricing.js'

/**
 * Aggregates historic orders. Order lines carry the unit price and tax rate that
 * applied at the time of sale, so amounts are recomputed from those values.
 */
export function salesReport(orders) {
  const bySku = {}
  const roundCents = (n) => Math.round(n * 100) / 100
  for (const order of orders) {
    for (const line of order.lines) {
      const { net, tax, total } = computeLineTotal({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPct: line.discountPct ?? 0,
        taxRate: line.taxRate ?? 0,
      })
      const entry = (bySku[line.sku] ??= { quantity: 0, net: 0, tax: 0, total: 0 })
      entry.quantity += line.quantity
      entry.net = roundCents(entry.net + net)
      entry.tax = roundCents(entry.tax + tax)
      entry.total = roundCents(entry.total + total)
    }
  }
  const grandTotal = roundCents(Object.values(bySku).reduce((s, e) => s + e.total, 0))
  return { bySku, grandTotal }
}
