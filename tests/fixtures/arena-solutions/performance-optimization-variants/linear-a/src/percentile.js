function rankOf(sorted, p) {
  if (sorted.length === 0) return 0
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

export function percentile(values, p) {
  return rankOf(Float64Array.from(values).sort(), p)
}

/** Variant A: one typed-array sort per call (numeric order without a comparator). */
export function latencySummary(events, percentiles = [50, 90, 99]) {
  const sorted = Float64Array.from(events, (event) => event.latencyMs).sort()
  const summary = {}
  for (const p of percentiles) summary[`p${p}`] = rankOf(sorted, p)
  return summary
}
