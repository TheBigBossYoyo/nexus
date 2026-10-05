const RATES = {
  US: { standard: 0.0725, reduced: 0.0725, zero: 0 },
  EU: { standard: 0.2, reduced: 0.07, zero: 0 },
}

export function taxRateFor(category, region = 'US') {
  const table = RATES[region]
  if (!table) throw new Error(`Unknown region: ${region}`)
  const rate = table[category]
  if (rate === undefined) throw new Error(`Unknown tax category: ${category}`)
  return rate
}
