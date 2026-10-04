# contacts-store

A tiny JSON-file-backed contact book used by internal tooling scripts.

The store is a single JSON document with a `version` field and a `records` array.
Version 1 is the only format in use today:

```json
{ "version": 1, "records": [
  { "id": "1", "name": "Ada Lovelace", "email": "ada@example.com",
    "created": 1700000000000, "tags": "vip, speaker" } ] }
```

API: `loadStore`, `saveStore`, `addContact`, `search`, `listByTag`, `displayName`, `formatContactLine`.

Run the tests with `npm test` (no install needed).
