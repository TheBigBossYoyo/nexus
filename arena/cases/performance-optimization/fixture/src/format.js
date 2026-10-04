/** Render a report as plain text. */
export function formatReport(report) {
  const latency = Object.entries(report.latency)
    .map(([name, value]) => `${name}=${value}ms`)
    .join(' ')
  const lines = [
    `events: ${report.total} (${report.unique} unique, ${report.skipped} skipped)`,
    `peak error rate: ${(report.peakErrorRate * 100).toFixed(1)}%`,
    `latency: ${latency}`,
    'services:',
  ]
  for (const row of report.services) {
    lines.push(`  ${row.service} count=${row.count} errors=${row.errors} avg=${row.avgLatencyMs.toFixed(1)}ms max=${row.maxLatencyMs}ms`)
  }
  return lines.join('\n')
}
