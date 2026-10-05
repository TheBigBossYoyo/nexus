import { getProduct } from './catalog.js'
import { taxRateFor } from './tax.js'
import { validateItems } from './validate.js'
import { computeLineTotal } from './pricing.js'

export function createInvoice({ customer, region = 'US', items }) {
  validateItems(items)
  const lines = items.map((item) => {
    const product = getProduct(item.sku)
    const { net, tax, total } = computeLineTotal({
      quantity: item.quantity,
      unitPrice: product.unitPrice,
      discountPct: item.discountPct || 0,
      taxRate: taxRateFor(product.taxCategory, region),
    })
    return {
      sku: product.sku,
      name: product.name,
      quantity: item.quantity,
      unitPrice: product.unitPrice,
      discountPct: item.discountPct || 0,
      net,
      tax,
      total,
    }
  })
  const subtotal = Math.round(lines.reduce((s, l) => s + l.net, 0) * 100) / 100
  const taxTotal = Math.round(lines.reduce((s, l) => s + l.tax, 0) * 100) / 100
  return {
    customer,
    region,
    lines,
    subtotal,
    taxTotal,
    total: Math.round((subtotal + taxTotal) * 100) / 100,
  }
}
