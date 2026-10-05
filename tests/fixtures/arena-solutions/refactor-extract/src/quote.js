import { getProduct } from './catalog.js'
import { taxRateFor } from './tax.js'
import { validateItems } from './validate.js'
import { computeLineTotal } from './pricing.js'

const VOLUME_THRESHOLD = 10
const VOLUME_DISCOUNT_PCT = 5

export function createQuote(items, { region = 'US', validDays = 14 } = {}) {
  validateItems(items)
  const round2 = (value) => Math.round(value * 100) / 100
  const lines = items.map((item) => {
    const product = getProduct(item.sku)
    const volume = item.quantity >= VOLUME_THRESHOLD ? VOLUME_DISCOUNT_PCT : 0
    const discountPct = Math.max(item.discountPct || 0, volume)
    const { net, tax, total } = computeLineTotal({
      quantity: item.quantity,
      unitPrice: product.unitPrice,
      discountPct,
      taxRate: taxRateFor(product.taxCategory, region),
    })
    return { sku: product.sku, quantity: item.quantity, unitPrice: product.unitPrice, discountPct, net, tax, total }
  })
  return {
    region,
    validDays,
    lines,
    total: round2(lines.reduce((sum, line) => sum + line.total, 0)),
  }
}
