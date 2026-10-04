# kvlog

An embedded, single-process key/value store. Every write is appended to a journal (`journal.log`); a snapshot
(`snapshot.json`) periodically captures the whole state and lets the journal be emptied. `LOCK` keeps two
processes from opening the same directory.

```js
import { openStore } from './src/index.js'

const store = openStore('./data')          // options: { snapshotEvery, fs }
store.set('user:1', { name: 'Ada' })
store.incr('visits')                       // returns the new value
store.delete('user:1')
store.snapshot()                           // also runs automatically every `snapshotEvery` journal records
store.close()
```

API: `get`, `has`, `keys` (sorted), `size`, `set`, `delete`, `incr`, `snapshot`, `stats`, `close`.
Values must be JSON-serialisable. Errors are `StoreError` with `code` `LOCKED`, `CORRUPT` or `CLOSED`.

## On-disk format

- `journal.log`: one record per line, `<crc32 hex> <json>\n`. The JSON holds `seq` (strictly increasing from 1),
  `op` (`set`, `delete`, `incr`) and its arguments.
- `snapshot.json`: `{ version, seq, crc, entries }` where `seq` is the sequence number of the last record it includes.
- `LOCK`: the decimal process id of the owner.

The `fs` option accepts any `node:fs`-compatible object; the store uses it for all file access.

Run the tests with `npm test`.
