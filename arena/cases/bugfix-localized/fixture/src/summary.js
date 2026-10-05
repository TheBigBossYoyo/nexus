/** "Showing 11-20 of 45" style text for a paginate() result. */
export function describePage(result) {
  if (result.totalItems === 0) return 'No results'
  const first = result.startIndex + 1
  const last = result.endIndex
  return `Showing ${first}-${last} of ${result.totalItems}`
}
