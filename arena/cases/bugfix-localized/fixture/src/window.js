import { assertPositiveInteger } from './validate.js'

/**
 * Page numbers to render in a pager. First and last page are always present,
 * `radius` pages are shown either side of the current page, and gaps become '...'.
 */
export function pageWindow(page, totalPages, radius = 1) {
  assertPositiveInteger(page, 'page')
  if (!Number.isInteger(totalPages) || totalPages < 0) {
    throw new RangeError('totalPages must be a non-negative integer')
  }
  if (totalPages === 0) return []
  const current = Math.min(page, totalPages)
  const wanted = new Set([1, totalPages])
  for (let p = current - radius; p <= current + radius; p += 1) {
    if (p >= 1 && p <= totalPages) wanted.add(p)
  }
  const sorted = [...wanted].sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      out.push(sorted[i] - sorted[i - 1] === 2 ? sorted[i] - 1 : '...')
    }
    out.push(sorted[i])
  }
  return out
}
