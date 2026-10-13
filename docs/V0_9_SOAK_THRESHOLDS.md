# NEXUS 0.9: what the long soak is judged by

Fixed on 2026-10-13, before any long run of 0.9 was made. The numbers are in code
(`tests/helpers/trend.ts`, `SOAK_LIMITS`) and the soak reads them from there. If a number is changed after a run
has been seen, the release report says which, when and why; a run is never re-judged quietly.

## How a metric is judged

By its trend over one uninterrupted start of a process, not by its last value.

- The first tenth of a segment is warm-up and is left out.
- **Slope**: the median of the slopes between pairs of samples (Theil-Sen), per hour. One spike does not move it.
- **Level**: the median of the last quarter against the median of the first quarter, after a slack is added to
  the first (small numbers double without meaning anything).
- A metric **fails** when both are over their limit: it climbs and it has ended well above where it began.
  A step to a new level that then stays flat passes the slope and is reported. Noise passes the level.
- A segment with fewer than 12 samples or less than half an hour says TOO_SHORT. That is not a pass: the soak
  must contain at least one segment of three hours or more for every growth metric.

## Growth limits (one start of the runtime)

| Metric | Per hour | Level ratio | Slack |
|---|---|---|---|
| Resident memory of the runtime (MB) | 15 | 1.5 | 20 |
| JavaScript heap in use (MB) | 8 | 1.6 | 15 |
| Private bytes, as Windows counts them (MB) | 15 | 1.5 | 20 |
| Handles of the runtime process, as Windows counts them | 40 | 1.5 | 100 |
| Threads of the runtime process | 2 | 1.5 | 8 |
| Active handles and pending timers of the event loop | 5 | 2 | 20 |
| Processes of the soak on the machine (workers, launchers, shells, browsers) | 1 | 1.5 | 6 |

## What must grow no faster than the work

The database file, the rows of the event log and the rows of the Context Graph grow with what was done. The
cost per finished item in the last third of the run must be at most twice the cost in the first third. The
write-ahead log stays under 200 MB at every sample.

## Latency

A status request to the runtime and the admission of a mission are timed throughout. The 95th percentile of
the last quarter must be at most twice that of the first quarter plus 50 ms.

## Exactly zero when the soak has drained and stopped

Orphan processes of any kind (a worker tree, a launcher, a shell, a development server); orphan browsers;
listening ports of the soak; browser profile directories; spec files; session directories of this instance in
the sandbox root; access entries for a capability of a session that no longer exists; active leases; a mission
or queue item that reached two terminal states or finished twice.

## The same before and after

The scheduled tasks named Nexus (one), the firewall rules named Nexus (two), the access list of the Mount
Manager device, the access list of the sandbox root.

## At every sample

No agent session holds two active leases; no worker holds two; the active agents are within the limit; the
live workers are within the limit plus one.

## What the soak contains

Hours of scripted missions, Programs and Workspaces through the real runtime process with real worker
processes; contained commands under ISOLATED and RESTRICTED, some failing, timing out and leaving children;
application launches with a real headless browser, some crashing; research fetches against a local server;
quota states changing; workers killed; the runtime killed and started again; clients (the window) coming and
going; the proxy of a session going away. No real provider is used: what a soak proves is deterministic.

The target is 12 hours or more on the final candidate source. A shorter soak on earlier source is evidence of
its own and is reported with its commit.
