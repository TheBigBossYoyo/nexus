export const DEFAULT_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR']

export function isErrorLevel(level) {
  return level === 'ERROR'
}
