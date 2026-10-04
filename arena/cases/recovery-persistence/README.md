# recovery-persistence

Category: infrastructure. Complexity: large (high). Risk: high.

## What it measures

Whether an agent can make a journal-plus-snapshot key/value store crash-safe without changing its API or on-disk
format. Planted defects: any damaged journal line aborts loading (torn tail not tolerated or truncated), the snapshot
is written in place (no temp file and rename), replay ignores sequence numbers so `incr` is applied twice after a
crash between snapshot and journal reset, a LOCK left by a dead process blocks reopening, and writes mutate memory
before the journal append so a failed write is still visible.

## How crashes are simulated (deterministic, in temp directories)

- On-disk states are produced by editing files: truncated or garbage-extended journals, zero-filled tails, a journal
  restored after a snapshot, a stale `LOCK` with a dead pid (from a finished child process) or a live one (the parent pid),
  leftover temporary snapshot files, damaged snapshots and mid-journal damage.
- The public `fs` option is used to inject a wrapper over `node:fs` that tears or fails writes to `snapshot.json`,
  to temporary snapshot files, to `journal.log`, or fails `renameSync`. It intercepts `writeFileSync`, `appendFileSync`,
  `openSync`/`writeSync` and `renameSync`, so different implementations are exercised equivalently.
- A seeded random workload takes crash copies of the data directory (without `LOCK`) after random steps and compares
  each recovered store with a model, including torn tails followed by new writes.

## Why it is fair

Every guarantee tested is stated in the task prompt (acknowledged writes survive, failed writes are invisible, torn
tail dropped and removed, real corruption raises `CORRUPT`, snapshots are interruptible, no double replay, stale vs.
live locks). Only the documented API, file names and formats are relied on. Failing snapshots may throw or not; the
live handle is only required to stay consistent. Superficial fixes that fail: ignoring a torn tail in memory without
truncating it (the next append is glued to the fragment and lost), swallowing all journal/snapshot errors (real
corruption must still raise), treating every existing LOCK as stale (a second handle must still be refused), and
checking sequence numbers only when a snapshot exists.
