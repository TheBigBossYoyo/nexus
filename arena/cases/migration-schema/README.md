# migration-schema

Category: migration. Complexity: medium. Risk: high (user data on disk).

## What it measures
Whether an agent can implement a data migration safely: converting several fields at once,
preserving everything it does not understand, backing up before replacing, writing atomically,
being idempotent, refusing formats from the future and surviving corrupt entries.

## Fixture
`contacts-store`: a JSON-file-backed contact book (loader, saver, contacts API, formatter) at schema v1
with passing visible tests that run against real temp files.

## Hidden evaluation
Builds v1, v2, future-version, broken and partially corrupt files in a temp dir and checks field-level
conversion (including ISO millisecond precision and epoch 0), byte-exact `.bak`, disk write-back, no stray
temp files, repeated loads, untouched files on refusal, quarantine contents (index, reason, original raw)
and that the contacts API works against v1 input and writes v2 records.

## Why it is fair
All file formats, exported names, error codes and the name-splitting rule are specified in the prompt.
Tests only use public functions. A superficial fix fails: in-memory-only migration (no write-back),
dropping or crashing on bad entries, losing extra fields, overwriting the backup on the second load,
treating epoch 0 or empty tags as corrupt, or migrating the loader but leaving `search`/`displayName`
on the v1 shape.
