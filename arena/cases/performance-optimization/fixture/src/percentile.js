/** Nearest-rank percentile of a list of numbers. Returns 0 for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

/** Latency percentiles keyed `p<N>`, e.g. { p50, p90, p99 }. */
export function latencySummary(events, percentiles = [50, 90, 99]) {
  const summary = {}
  for (const p of percentiles) {
    summary[`p${p}`] = percentile(
      events.map((event) => event.latencyMs),
      p,
    )
  }
  return summary
}
