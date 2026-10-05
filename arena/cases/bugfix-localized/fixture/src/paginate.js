import { pageCount } from './page-count.js'
import { assertArray, assertPositiveInteger } from './validate.js'

/**
 * Slice `items` into a page. Pages are 1-based. A page past the end is clamped
 * to the last page, so callers always get a usable result.
 */
export function paginate(items, { page = 1, pageSize = 10 } = {}) {
  assertArray(items, 'items')
  assertPositiveInteger(page, 'page')
  assertPositiveInteger(pageSize, 'pageSize')

  const totalItems = items.length
  const totalPages = pageCount(totalItems, pageSize)
  const current = Math.min(page, Math.max(totalPages, 1))
  const startIndex = (current - 1) * pageSize
  const slice = items.slice(startIndex, startIndex + pageSize)

  return {
    items: slice,
    page: current,
    pageSize,
    totalItems,
    totalPages,
    hasPrev: current > 1,
    hasNext: current < totalPages,
    startIndex: slice.length === 0 ? 0 : startIndex,
    endIndex: slice.length === 0 ? 0 : startIndex + slice.length,
  }
}
