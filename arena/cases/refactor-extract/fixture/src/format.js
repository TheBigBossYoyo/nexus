export function formatMoney(amount, currency = '$') {
  const sign = amount < 0 ? '-' : ''
  const [whole, cents] = Math.abs(amount).toFixed(2).split('.')
  return `${sign}${currency}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`
}
