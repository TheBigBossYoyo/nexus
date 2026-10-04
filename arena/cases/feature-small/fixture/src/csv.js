function escapeField(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(report) {
  const lines = [report.headers, ...report.rows].map((cells) => cells.map(escapeField).join(','))
  return `${lines.join('\n')}\n`
}
