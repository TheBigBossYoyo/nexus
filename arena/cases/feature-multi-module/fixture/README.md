# todo-service

A small todo list library.

- `createTask`, `completeTask` (src/model.js): task model, a task is `{ id, title, done }`.
- `serializeTasks`, `deserializeTasks` (src/storage.js): versioned JSON text format. Files written so far use `"version": 1`.
- `FileStore`, `MemoryStore` (src/stores.js): persistence behind `load()` / `save(tasks)`.
- `TodoService` (src/service.js): `add`, `complete`, `remove`, `list`; every mutation is saved to the store.
- `renderTasks` (src/render.js): text listing, one line per task.
- `runCommand(argv, service)` (src/cli.js): `add <title>`, `list [--open]`, `done <id>`; returns the output text.

Everything is exported from `src/index.js`. Run the tests with `npm test`.

Existing data files must keep loading after any change to the format.
