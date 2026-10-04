import { mergeLines, normalizeSku } from './lines.js'

/** Stock levels per SKU with all-or-nothing reservations. */
export class Inventory {
  #stock = new Map()

  constructor(initial = {}) {
    for (const [sku, qty] of Object.entries(initial)) {
      this.#stock.set(normalizeSku(sku), qty)
    }
  }

  available(sku) {
    return this.#stock.get(normalizeSku(sku)) ?? 0
  }

  /** Reserve stock for every line of the order, or change nothing and throw. */
  reserve(order) {
    const wanted = mergeLines(order.lines)
    for (const line of wanted) {
      if (this.available(line.sku) < line.qty) {
        throw new RangeError(`insufficient stock for ${line.sku}: wanted ${line.qty}, have ${this.available(line.sku)}`)
      }
    }
    for (const line of wanted) {
      this.#stock.set(line.sku, this.available(line.sku) - line.qty)
    }
    return wanted.map((line) => ({ sku: line.sku, qty: line.qty }))
  }

  snapshot() {
    return Object.fromEntries([...this.#stock.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  }
}
