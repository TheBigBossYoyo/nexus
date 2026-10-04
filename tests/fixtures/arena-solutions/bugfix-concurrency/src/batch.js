import { JobQueue } from './queue.js'

// Maps items through an async function with at most limit calls in flight.
// Results keep the input order. After the first failure no further items are started.
export async function mapLimit(items, limit, fn) {
  const queue = new JobQueue({ concurrency: limit })
  let failed = false
  return Promise.all(
    items.map((item, index) =>
      queue.add(async () => {
        if (failed) return undefined
        try {
          return await fn(item, index)
        } catch (error) {
          failed = true
          throw error
        }
      }),
    ),
  )
}
