export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '')
  const [whole, frac] = String(Math.abs(value)).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${value < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`
}
