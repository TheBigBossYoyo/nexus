# bugfix-concurrency

Category: bugfix. Complexity: large (high). Risk: high.

## What it measures
Diagnosing and fixing several related concurrency defects in one small async library:
missing in-flight de-duplication, cache poisoning by rejections, stale writes after invalidation,
permit leaks on failure, cancelled waiters that swallow permits, `onIdle()` hanging after failures
and a batch helper that keeps scheduling after an error.

## Fixture
`taskkit`: `Semaphore`, `JobQueue`, `AsyncCache`, `mapLimit` plus helpers. Visible tests only cover happy paths.

## Hidden evaluation
Fully deterministic: controlled deferred promises, `setImmediate` flushes (no timers, no sleeps) and
an injected clock. Hung promises are tracked instead of awaited so a wrong fix fails by assertion,
not by timeout. Covers shared loads, rejection fan-out and non-caching, sync-throwing loaders,
invalidate/clear during flight (including a stale load finishing after a newer one), TTL from arrival,
permit accounting under contention, abort before/during/after grant, FIFO around cancelled waiters,
`pending`/`onIdle` with failures and cancellations, and `mapLimit` early-stop semantics.

## Why it is fair
Every behaviour asserted is written in the prompt or README of the fixture and uses only the public API.
Superficial fixes fail: a naive in-flight map that keeps rejected promises (poisoned key), one that is not
cleaned on a synchronous throw, `try/finally` in `run` without removing aborted waiters, or a cache that
lets a stale load overwrite a newer value.
