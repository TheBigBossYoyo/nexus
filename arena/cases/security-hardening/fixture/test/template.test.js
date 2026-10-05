import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../src/index.js'

test('render fills placeholders, including nested paths', () => {
  const out = render('<p>Hello {{ user.name }}, you have {{count}} messages.</p>', { user: { name: 'Ada' }, count: 3 })
  assert.equal(out, '<p>Hello Ada, you have 3 messages.</p>')
})

test('missing values render as empty text', () => {
  assert.equal(render('[{{ a }}][{{ b.c }}][{{ n }}]', { b: {}, n: null }), '[][][]')
})
