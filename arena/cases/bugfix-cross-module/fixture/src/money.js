/** Money helpers. All amounts inside the pipeline are integer cents. */

export function toCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`invalid amount: ${String(amount)}`)
  }
  return Math.round(amount * 100)
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${sign}$${whole}.${frac}`
}

export function applyRate(cents, rate) {
  return Math.round(cents * rate)
}
