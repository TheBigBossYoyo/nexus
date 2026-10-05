# logstat

A small, dependency-free toolkit that turns raw service logs into a report.

## Log format

    <timestamp> <LEVEL> <service> <latency>ms [message]
    2024-03-01T12:00:00.000Z WARN checkout 183ms retrying payment

Lines that do not match are counted as `skipped`; blank lines are ignored.

## API

- `parseLine(line, levels?)` and `parseLog(text, { levels? })` -> `{ events, skipped }`
- `dedupeEvents(events, keyOf?)` keeps the first event for every key (default key: timestamp, service, message)
- `rollingErrorRate(events, windowMs)` for every event, the errors in the window `(ts - windowMs, ts]`. Events must be sorted by `ts`. A window of 0 contains nothing.
- `serviceTable(events)` per-service count, errors, average and maximum latency, busiest first
- `percentile(values, p)` nearest-rank percentile, `latencySummary(events, percentiles?)`
- `buildReport(text, options?)` and `formatReport(report)`

Run the tests with `npm test`.
