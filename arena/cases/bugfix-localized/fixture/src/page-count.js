import { assertPositiveInteger } from './validate.js'

/**
 * Number of pages needed to show `totalItems` items, `pageSize` per page.
 * An empty list has zero pages.
 */
export function pageCount(totalItems, pageSize) {
  assertPositiveInteger(pageSize, 'pageSize')
  if (!Number.isInteger(totalItems) || totalItems < 0) {
    throw new RangeError(`totalItems must be a non-negative integer, received ${String(totalItems)}`)
  }
  if (totalItems === 0) return 0
  const full = Math.floor(totalItems / pageSize)
  const remainder = totalItems % pageSize
  return remainder > 1 ? full + 1 : full
}
