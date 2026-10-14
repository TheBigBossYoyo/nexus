Three improvements to the notes app.

1. Tags: a note may carry tags written as #words in its text ("Buy milk #shopping"). lib/notes.js stores them on each note (a `tags` array, lowercase, without the #, in the order written, no duplicates) and the API returns them. The page shows each note's tags as small labels after its text.
2. Editing: each note in the page gets an "Edit" button that turns its text into an input; Enter or a "Save" button saves through a new PATCH /api/notes/:id (same validation as adding: not empty, at most 500 characters), Escape cancels.
3. Counts: the page title shows the number of notes, "Notes (3)", and updates after every change.

Each part has unit tests for what lib/ does (node --test, files in test/). Check the whole in the running app: add "Buy milk #shopping #Food", edit it to "Buy oat milk #shopping", and confirm the text, the tags (shopping) and the title count.

Constraints: no dependencies; keep the existing API working as it is.
