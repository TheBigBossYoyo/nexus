# pager-kit

Small, dependency-free pagination helpers for list views.

- `paginate(items, { page, pageSize })` slices a list and returns paging metadata.
- `pageCount(totalItems, pageSize)` number of pages needed for a list.
- `pageWindow(page, totalPages, radius)` page numbers for a pager widget, with `'...'` gaps.
- `describePage(result)` human readable "Showing 11-20 of 45" text.
- `pageFromQuery(search, totalPages)` reads `?page=` from a query string and clamps it.

Run the tests with `npm test` (uses `node --test`).
