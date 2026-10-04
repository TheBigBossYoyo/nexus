/** Read a 1-based page number from a query string such as "?q=a&page=3". */
export function pageFromQuery(search, totalPages) {
  const params = new URLSearchParams(search)
  const raw = params.get('page')
  const parsed = raw === null ? 1 : Number.parseInt(raw, 10)
  const page = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
  return Math.min(page, Math.max(totalPages, 1))
}
