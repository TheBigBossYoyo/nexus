import { formatCents } from './money.js'

/** Plain-text invoice for a priced order. */
export function renderInvoice(priced) {
  const rows = priced.lines.map(
    (line) => `${line.sku.padEnd(10)} ${String(line.qty).padStart(3)} x ${formatCents(line.unitCents).padStart(9)} = ${formatCents(line.totalCents).padStart(10)}`,
  )
  return [
    `Invoice for order ${priced.orderId} (${priced.customer})`,
    ...rows,
    `Subtotal: ${formatCents(priced.subtotalCents)}`,
    `Tax: ${formatCents(priced.taxCents)}`,
    `Total: ${formatCents(priced.totalCents)}`,
  ].join('\n')
}
