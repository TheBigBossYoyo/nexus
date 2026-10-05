import { getProduct } from './catalog.js'
import { taxRateFor } from './tax.js'
import { validateItems } from './validate.js'

const VOLUME_THRESHOLD = 10
const VOLUME_DISCOUNT_PCT = 5

export function createQuote(items, { region = 'US', validDays = 14 } = {}) {
  validateItems(items)
  const round2 = (value) => Math.round(value * 100) / 100
  const lines = items.map((item) => {
    const product = getProduct(item.sku)
    const volume = item.quantity >= VOLUME_THRESHOLD ? VOLUME_DISCOUNT_PCT : 0
    const discountPct = Math.max(item.discountPct || 0, volume)
    const rate = taxRateFor(product.taxCategory, region)
    const net = round2(item.quantity * product.unitPrice * (1 - discountPct / 100))
    const tax = round2(net * rate)
    return {
      sku: product.sku,
      quantity: item.quantity,
      unitPrice: product.unitPrice,
      discountPct,
      net,
      tax,
      total: round2(net + tax),
    }
  })
  return {
    region,
    validDays,
    lines,
    total: round2(lines.reduce((sum, line) => sum + line.total, 0)),
  }
}
