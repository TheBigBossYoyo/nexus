# taskkit

Small, dependency-free async coordination helpers.

- `Semaphore(n)`: `acquire({ signal })`, `release()`, `run(fn, { signal })`. Permits are handed over in FIFO order and a waiting `acquire` can be cancelled with an `AbortSignal`.
- `JobQueue({ concurrency })`: `add(job, { signal })` returns the job result; `onIdle()` resolves once every added job has finished (successfully or not); `pending` counts unfinished jobs.
- `AsyncCache({ ttlMs, now })`: `get(key, loader)` is a read-through cache. Concurrent requests for the same key share one load. `invalidate(key)` / `clear()` discard cached values and also anything still loading for them.
- `mapLimit(items, limit, fn)`: ordered results; stops starting new items after the first failure.

Run the tests with `npm test` (no install needed).
