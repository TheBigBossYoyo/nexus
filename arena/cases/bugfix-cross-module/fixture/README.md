# order-desk

A small order pipeline: price an order, reserve stock for it, render an invoice.

- `priceOrder(order, catalog)` totals an order in integer cents (8.25% tax by default).
- `Inventory` tracks stock per SKU; `reserve(order)` is all-or-nothing.
- `renderInvoice(priced)` formats a priced order as text.
- `processOrder(order, catalog, inventory)` runs the whole pipeline.

An order looks like `{ id, customer, lines: [{ sku, qty }] }`. Lines may repeat a SKU and SKUs
may differ in case or surrounding whitespace; they are merged before pricing and reservation.

Run the tests with `npm test`.
