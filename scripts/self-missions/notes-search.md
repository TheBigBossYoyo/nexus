Add a search box to the notes app that filters the notes shown as the user types.

What to do:
- Put the filtering in a new module lib/filter.js: a function filterNotes(notes, query) that keeps the notes whose text contains the query, ignoring case and surrounding spaces; an empty query keeps every note.
- Add unit tests for it in test/filter.test.js (empty query, a match in the middle of a word, case, no match).
- In public/index.html add a search input (id "search", placeholder "Search notes") between the form and the list. public/app.js uses filterNotes on every keystroke; when notes exist but none match it shows "No notes match" in the list area.
- Check it in the running application: start it, add three notes ("Buy milk", "Call Sam", "milkshake recipe"), type "MILK" in the search box and confirm that exactly the two matching notes are shown, then type "zzz" and confirm "No notes match" is shown.

Constraints:
- No dependencies: the app stays plain Node and browser JavaScript.
- Do not change the API of server.js.
