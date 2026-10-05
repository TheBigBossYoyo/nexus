const defaultRound = (value) => Math.round(value * 100) / 100

let roundFn = defaultRound

export function roundMoney(value) {
  return roundFn(value)
}

export function setRoundingFunction(fn) {
  if (typeof fn !== 'function') throw new TypeError('rounding function required')
  roundFn = fn
}

export function resetRoundingFunction() {
  roundFn = defaultRound
}

export function computeLineTotal({ quantity, unitPrice, discountPct = 0, taxRate = 0 }) {
  const net = roundFn(quantity * unitPrice * (1 - discountPct / 100))
  const tax = roundFn(net * taxRate)
  return { net, tax, total: roundFn(net + tax) }
}
