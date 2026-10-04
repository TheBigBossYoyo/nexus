import { normalizeSku } from './lines.js'
import { toCents } from './money.js'

/** Price list keyed by SKU. Prices are given in dollars and stored as cents. */
export class Catalog {
  #prices = new Map()

  constructor(entries = {}) {
    for (const [sku, dollars] of Object.entries(entries)) {
      this.#prices.set(normalizeSku(sku), toCents(dollars))
    }
  }

  priceCents(sku) {
    const cents = this.#prices.get(normalizeSku(sku))
    if (cents === undefined) {
      throw new RangeError(`unknown sku: ${String(sku).trim()}`)
    }
    return cents
  }

  has(sku) {
    return this.#prices.has(normalizeSku(sku))
  }
}
