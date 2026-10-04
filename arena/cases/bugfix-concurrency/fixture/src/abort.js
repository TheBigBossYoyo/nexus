export function abortError(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}
