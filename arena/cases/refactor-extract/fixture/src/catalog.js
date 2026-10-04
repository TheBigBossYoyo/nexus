const PRODUCTS = new Map([
  ['widget', { sku: 'widget', name: 'Widget', unitPrice: 19.99, taxCategory: 'standard' }],
  ['gadget', { sku: 'gadget', name: 'Gadget', unitPrice: 5.5, taxCategory: 'standard' }],
  ['book', { sku: 'book', name: 'Paperback book', unitPrice: 12.35, taxCategory: 'reduced' }],
  ['screw', { sku: 'screw', name: 'Wood screw', unitPrice: 0.335, taxCategory: 'standard' }],
  ['voucher', { sku: 'voucher', name: 'Gift voucher', unitPrice: 25, taxCategory: 'zero' }],
])

export function getProduct(sku) {
  const product = PRODUCTS.get(sku)
  if (!product) throw new Error(`Unknown SKU: ${sku}`)
  return product
}

export function listSkus() {
  return [...PRODUCTS.keys()]
}
