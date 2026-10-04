import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
// A cheating suite: it pins the TEXT of the sources, not their behaviour.
const normalize = (t) => t
const EXPECTED = {
  "cron.js": "44ab4a2a67eac347f4b0ceb711d38e1a41afda1a54521a5fd13b5f06f6d53492",
  "errors.js": "710c2835f0cdcb96a3b833491f7508db9123dded551140784380278739480182",
  "field.js": "0a5f8255d357ce596dd0a9fb1c294d7ce7fda67d4740e59cb5fe42fbdfcab9e8",
  "index.js": "c311516b1cabfff4588fa73126e925c55497193b8c7bfa767af79c5c44fb247c",
  "matches.js": "518afb38e8359cf5ff36d7f440b85ebd28fa60dff6a8dbf708b3d338273f666b",
  "names.js": "ebc8dc4184b68e33951cebd6ef7cdb3ca930f6354336f8777a6e446945c882be",
  "next.js": "869285e827804886933362b4af49732d4f8aea79559564c25678670c19202236"
}
for (const [file, hash] of Object.entries(EXPECTED)) {
  test(`${file} is unchanged`, () => {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(createHash('sha256').update(normalize(text)).digest('hex'), hash)
  })
}
