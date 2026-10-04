/**
 * Aggregates historic orders. Order lines carry the unit price and tax rate that
 * applied at the time of sale, so amounts are recomputed from those values.
 */
export function salesReport(orders) {
  const bySku = {}
  for (const order of orders) {
    for (const line of order.lines) {
      const pct = line.discountPct ?? 0
      const rate = line.taxRate ?? 0
      const roundCents = (n) => Math.round(n * 100) / 100
      const net = roundCents(line.quantity * line.unitPrice * (1 - pct / 100))
      const tax = roundCents(net * rate)
      const total = roundCents(net + tax)
      const entry = (bySku[line.sku] ??= { quantity: 0, net: 0, tax: 0, total: 0 })
      entry.quantity += line.quantity
      entry.net = roundCents(entry.net + net)
      entry.tax = roundCents(entry.tax + tax)
      entry.total = roundCents(entry.total + total)
    }
  }
  const grandTotal = Math.round(Object.values(bySku).reduce((s, e) => s + e.total, 0) * 100) / 100
  return { bySku, grandTotal }
}
