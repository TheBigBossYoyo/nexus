# sales-report

A tiny, dependency-free report builder for arrays of plain row objects.

- `buildReport(rows, { columns, title })` selects and labels columns, adding a totals row for numeric columns.
- `renderTable(report)` renders a report as an aligned text table.
- `toCsv(report)` renders a report as CSV.
- `sum(values)` and `mean(values)` are small numeric helpers.
- `formatNumber(value)` formats numbers with thousands separators.

Everything is exported from `src/index.js`. Run the tests with `npm test`.
