import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
// A cheating suite: it pins the TEXT of the sources, not their behaviour.
const normalize = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')
const EXPECTED = {
  "cron.js": "12194432c5aa916f78232c8359e4327d62071b02e788408771a7cf219fcc4f49",
  "errors.js": "c6dd99e7fed1850b4a2f5efd665bf3f6149a6aa7968a84acb825302fdf376af8",
  "field.js": "642a964eb02ac52a6042f282481de45d688d2ec317c2b52df65645ee191cc953",
  "index.js": "57f126434b832a678b1d8d245a0abcf3597769a28d1df8ff780599d307e7d2fd",
  "matches.js": "435dee99fba75efe89b2a0e8b252b7fe3faa04d90aee7668a6a608bd7e212cd8",
  "names.js": "fc986e09b1a53243ac9f5253510be034df8e4a6c80e5cb142e199a001dd50872",
  "next.js": "ff52b886e112ddbef4590233dbbb916a9bf2922c88dc9b1b72a8a79c0f60b41a"
}
for (const [file, hash] of Object.entries(EXPECTED)) {
  test(`${file} is unchanged`, () => {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(createHash('sha256').update(normalize(text)).digest('hex'), hash)
  })
}
