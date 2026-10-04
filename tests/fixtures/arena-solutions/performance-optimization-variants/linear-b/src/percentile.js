function rankOf(sorted, p) {
  if (sorted.length === 0) return 0
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

/** Nearest-rank percentile of a list of numbers. Returns 0 for an empty list. */
export function percentile(values, p) {
  return rankOf([...values].sort((a, b) => a - b), p)
}

/** Latency percentiles keyed `p<N>`, e.g. { p50, p90, p99 }. */
export function latencySummary(events, percentiles = [50, 90, 99]) {
  const sorted = events.map((event) => event.latencyMs).sort((a, b) => a - b)
  const summary = {}
  for (const p of percentiles) summary[`p${p}`] = rankOf(sorted, p)
  return summary
}
