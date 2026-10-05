# billing-kit

Small, dependency-free helpers for invoices, quotes and sales reports.

- `createInvoice(order)` builds an invoice with per-line net, tax and total.
- `createQuote(items, options)` builds a quote; quantities of 10 or more get an automatic 5% volume discount.
- `salesReport(orders)` aggregates historic orders per SKU.
- `formatMoney(amount)` renders amounts for display.

Amounts are plain numbers rounded to cents.

Run the tests with `npm test` (uses `node --test`, no install needed).
