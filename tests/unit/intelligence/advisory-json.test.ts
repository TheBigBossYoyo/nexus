import { describe, expect, it } from 'vitest'
import { parseAdvisoryJson } from '@main/modules/intelligence/technical'

// 0.9.1: the Technical Director's answer, as models actually write it. Found when a mission started from the
// installed application failed with "Technical advisory output is not valid JSON".

describe('parseAdvisoryJson', () => {
  it('reads a bare object, a fenced one, and one after a sentence', () => {
    expect(parseAdvisoryJson('{"verdict":"APPROVE"}')).toEqual({ verdict: 'APPROVE' })
    expect(parseAdvisoryJson('```json\n{"verdict":"APPROVE"}\n```')).toEqual({ verdict: 'APPROVE' })
    expect(parseAdvisoryJson('  ```\n{"a":1}\n```  ')).toEqual({ a: 1 })
    expect(parseAdvisoryJson('Here is the review:\n{"a":{"b":[1,2]}}')).toEqual({ a: { b: [1, 2] } })
  })

  it('finds nothing where there is no JSON object', () => {
    expect(parseAdvisoryJson('I cannot review this.')).toBeUndefined()
    expect(parseAdvisoryJson('{not json}')).toBeUndefined()
    expect(parseAdvisoryJson('')).toBeUndefined()
  })
})
