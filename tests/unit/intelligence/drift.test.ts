import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Recommendation } from '@shared/intelligence'
import { structuredDriftFlags } from '@main/modules/intelligence/drift'

const item = (text: string, kind: Recommendation['kind'] = 'REQUIREMENT'): Recommendation => ({ text, kind, provenance: 'DIRECTOR_RECOMMENDED', evidenceRefs: [], requiresDecision: false }) as Recommendation

/**
 * Finding 7.2: whether a specification is ready rested on what the model said about its own additions, and the
 * code half knew five patterns. These are the additions a user must see whatever the model reports.
 */
describe('additions of consequence are flagged by code, whatever the model reports', () => {
  const raw = 'Fix the ordering of laps when the sequence counter wraps.'
  it.each([
    ['Add a new dependency on lodash for sorting', 'NEW_DEPENDENCY'],
    ['Install the library left-pad', 'NEW_DEPENDENCY'],
    ['Read the API key from .env and log the access token for debugging', 'SECRET_OR_CREDENTIAL_ACCESS'],
    ['Skip the flaky tests until the fix lands', 'VERIFICATION_WEAKENED'],
    ['Disable lint for the generated file', 'VERIFICATION_WEAKENED'],
    ['Upload the failing input to an external diagnostics service', 'EXTERNAL_DATA_TRANSFER'],
    ['Force-push the corrected history to the main branch', 'HISTORY_REWRITE'],
  ])('%s', (text, flag) => {
    expect(structuredDriftFlags(raw, [item(text)])).toContain(flag)
  })

  it('an item that forbids the thing is not a proposal to do it', () => {
    expect(structuredDriftFlags(raw, [
      item('Do not disable or skip any existing tests'),
      item('The fix must not add a new dependency'),
      item('Never log credentials or access tokens'),
      item('Avoid sending data to any external service endpoint'),
    ])).toEqual([])
  })

  it('a risk or a non-goal names the thing without proposing it', () => {
    expect(structuredDriftFlags(raw, [item('Someone may be tempted to skip the tests', 'RISK'), item('Adding a new dependency', 'NON_GOAL')])).toEqual([])
  })

  it('what the user asked for in their own words is not an addition', () => {
    expect(structuredDriftFlags('Add a dependency on zod and remove the obsolete tests of the old parser.', [item('Add the dependency zod'), item('Remove the tests of the old parser')])).toEqual([])
  })

  it('ordinary engineering advice raises nothing', () => {
    expect(structuredDriftFlags(raw, [
      item('Add a test for the wrap case using the existing test framework'),
      item('Remove the duplicated validation checks from the handlers'),
      item('Run npm test and confirm the package loads', 'VERIFICATION'),
      item('Keep the public API of the package unchanged', 'CONSTRAINT'),
      item('Establish by reading the repository which test command is used', 'UNKNOWN'),
    ])).toEqual([])
  })

  // The specifications real ChatGPT wrote for the six campaign requests: none asked for any of this, and a
  // pattern that fired on them would stop ordinary requests for a decision again (finding R.8).
  it('the real specifications of the campaign raise none of the new flags', () => {
    const dir = resolve(import.meta.dirname, '../../../docs/acceptance/campaign/specs-072')
    const fresh = ['NEW_DEPENDENCY', 'SECRET_OR_CREDENTIAL_ACCESS', 'VERIFICATION_WEAKENED', 'EXTERNAL_DATA_TRANSFER', 'HISTORY_REWRITE']
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const { spec } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { spec: { rawIntent: string; recommendations: Recommendation[] } }
      expect(structuredDriftFlags(spec.rawIntent, spec.recommendations).filter((f) => fresh.includes(f)), file).toEqual([])
    }
  })
})
