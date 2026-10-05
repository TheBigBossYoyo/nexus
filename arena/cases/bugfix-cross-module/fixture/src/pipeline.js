import { priceOrder } from './pricing.js'
import { renderInvoice } from './invoice.js'

/**
 * Price the order, reserve its stock and render the invoice. Pricing happens
 * first so an unknown SKU fails before any stock is touched.
 */
export function processOrder(order, catalog, inventory, options) {
  const priced = priceOrder(order, catalog, options)
  const reserved = inventory.reserve(order)
  return { priced, reserved, invoice: renderInvoice(priced) }
}
