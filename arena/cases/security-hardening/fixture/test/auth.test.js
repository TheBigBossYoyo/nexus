import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyToken, isAllowedOrigin } from '../src/index.js'

test('verifyToken accepts only the exact token', () => {
  assert.equal(verifyToken('s3cret-token', 's3cret-token'), true)
  assert.equal(verifyToken('s3cret-tokeN', 's3cret-token'), false)
  assert.equal(verifyToken('short', 's3cret-token'), false)
})

test('isAllowedOrigin matches configured origins', () => {
  const allowed = ['https://app.example.com', 'http://localhost:3000']
  assert.equal(isAllowedOrigin('https://app.example.com', allowed), true)
  assert.equal(isAllowedOrigin('http://localhost:3000', allowed), true)
  assert.equal(isAllowedOrigin('https://other.example.org', allowed), false)
})
