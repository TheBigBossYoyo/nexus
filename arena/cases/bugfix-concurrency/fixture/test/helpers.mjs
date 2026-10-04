// Lets every already queued promise reaction and I/O callback run.
export function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}
