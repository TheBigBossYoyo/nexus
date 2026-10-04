export function sum(values) {
  let total = 0
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

export function mean(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return numbers.length === 0 ? 0 : sum(numbers) / numbers.length
}
