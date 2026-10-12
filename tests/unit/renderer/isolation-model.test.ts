import { describe, expect, it } from 'vitest'
import type { ResearchScreening } from '../../../src/shared/research'
import {
  APPS_EMPTY,
  EFFECTIVE_LABEL,
  EFFECTIVE_SENTENCE,
  appStateTone,
  artifactHeading,
  availabilityWords,
  downloadName,
  downloadTone,
  effectiveLine,
  exitCodeWords,
  protectedSummary,
  quarantinedTotal,
  screenshotAlt,
  screeningWords,
  projectCodeAdvice, setupState,
  unusableWarning,
  projectCodeLine,
  setupRetryLine,
} from '../../../src/renderer/src/views/autonomy/isolationModel'

const screening = (extra: Partial<ResearchScreening> = {}): ResearchScreening => ({ status: 'clean', layers: [], quarantined: {}, hiddenChars: 0, strippedCharacters: 0, ...extra })

describe('isolation status wording', () => {
  it('labels every profile and says what it is', () => {
    for (const p of ['ISOLATED', 'RESTRICTED', 'STANDARD'] as const) {
      expect(EFFECTIVE_LABEL[p]).not.toMatch(/_|^[A-Z]+$/)
      expect(EFFECTIVE_SENTENCE[p].length).toBeGreaterThan(20)
    }
    expect(EFFECTIVE_SENTENCE.ISOLATED).toContain('administrator')
    expect(EFFECTIVE_SENTENCE.RESTRICTED).toContain('credential vault')
  })

  it('says whether the profile in effect held at this start', () => {
    expect(effectiveLine({ requested: 'ISOLATED', effective: 'ISOLATED', usable: true })).toBe('Isolated is in effect. It was verified at this start.')
    expect(effectiveLine({ requested: 'STRONGEST', effective: 'RESTRICTED', usable: true })).toBe('Restricted is in effect; Settings asks for the strongest available. It was verified at this start.')
    expect(effectiveLine({ requested: 'ISOLATED', effective: 'RESTRICTED', usable: false })).toBe('Restricted is in effect; Settings asks for Isolated. It could not be verified at this start.')
  })

  it('warns only when the profile is not usable', () => {
    expect(unusableWarning({ usable: true })).toBeNull()
    expect(unusableWarning({ usable: false })).toBe('Project code cannot run in an enrolled project until its containment is verified.')
    expect(unusableWarning({ usable: false }, true)).toBe('Project code cannot run in an enrolled project until its containment is verified. Run the setup below.')
    expect(unusableWarning({ usable: true }, true)).toBeNull()
  })

  it('ties the profile to the containment that is in effect', () => {
    expect(projectCodeLine({ effective: 'ISOLATED', usable: true }).label).toBe('Project code of an enrolled project currently runs: Isolated')
    expect(projectCodeLine({ effective: 'STANDARD', usable: true }).consequence).toBe(EFFECTIVE_SENTENCE.STANDARD)
    expect(projectCodeLine({ effective: 'RESTRICTED', usable: false }).consequence).toBe('Not verified at this start: enrolled projects run no command.')
  })

  it('promises nothing about a setup that stopped half way', () => {
    expect(setupRetryLine('Nothing was changed: the Windows elevation prompt was declined, or the setup did not start.')).toBe('You can try again.')
    expect(setupRetryLine('The setup did not complete: x')).toBe('The setup can be run again: it repairs what it made before.')
  })

  it('words availability, including a profile that was not checked', () => {
    expect(availabilityWords(null)).toBe('Not checked')
    expect(availabilityWords({ available: true })).toBe('Available')
    expect(availabilityWords({ available: false })).toBe('Not available')
  })

  it('chooses the setup control from the account and the build', () => {
    expect(setupState({ sandboxAccount: false, setupAvailable: true })).toBe('offer')
    expect(setupState({ sandboxAccount: false, setupAvailable: false })).toBe('unavailable')
    expect(setupState({ sandboxAccount: true, setupAvailable: true })).toBe('done')
    expect(setupState({ sandboxAccount: true, setupAvailable: false })).toBe('done')
    // An account that is there while the isolated profile did not pass its check: the setup is offered again.
    expect(setupState({ sandboxAccount: true, setupAvailable: true, isolated: { available: false } })).toBe('repair')
    expect(setupState({ sandboxAccount: true, setupAvailable: true, isolated: { available: true } })).toBe('done')
    expect(setupState({ sandboxAccount: true, setupAvailable: false, isolated: { available: false } })).toBe('done')
  })

  it('counts protected paths in words', () => {
    expect(protectedSummary(0)).toContain('no folder or file')
    expect(protectedSummary(1)).toBe('1 folder or file that contained code cannot read')
    expect(protectedSummary(7)).toBe('7 folders or files that contained code cannot read')
  })
})

describe('applications under test', () => {
  it('maps state to a tone and exit codes to words', () => {
    expect(appStateTone('running')).toBe('success')
    expect(appStateTone('starting')).toBe('active')
    expect(appStateTone('exited')).toBe('neutral')
    expect(exitCodeWords(null)).toBeNull()
    expect(exitCodeWords(0)).toBe('Exit code 0')
    expect(exitCodeWords(1)).toBe('Exit code 1')
  })

  it('writes meaningful alt text and an empty state', () => {
    expect(screenshotAlt('2026-10-11 09:30:00')).toBe('Screenshot of the application under test, taken 2026-10-11 09:30:00')
    expect(APPS_EMPTY).toContain('in this session of NEXUS')
  })
})

describe('web research', () => {
  it('sums the passages taken out over every pattern', () => {
    expect(quarantinedTotal(screening())).toBe(0)
    expect(quarantinedTotal(screening({ quarantined: { ignore_previous: 2, role_tag: 1 } }))).toBe(3)
  })

  it('says how many passages were taken out of a flagged text', () => {
    expect(screeningWords(screening({ status: 'not_run' })).label).toBe('Not screened')
    expect(screeningWords(screening()).detail).toBeNull()
    const flagged = screeningWords(screening({ status: 'flagged', quarantined: { a: 1 }, hiddenChars: 12, strippedCharacters: 3 }))
    expect(flagged.tone).toBe('danger')
    expect(flagged.detail).toBe('1 passage that read as instructions taken out; 12 hidden characters left out; 3 invisible or direction-control characters removed.')
    expect(screeningWords(screening({ status: 'flagged', quarantined: { a: 2, b: 2 } })).detail).toBe('4 passages that read as instructions taken out.')
  })

  it('heads an artifact with its title, else its address', () => {
    expect(artifactHeading({ title: ' Docs ', canonicalUrl: 'https://a.test/x', url: 'https://a.test/y' })).toBe('Docs')
    expect(artifactHeading({ title: null, canonicalUrl: 'https://a.test/x', url: 'https://a.test/y' })).toBe('https://a.test/x')
    expect(artifactHeading({ title: '', canonicalUrl: '', url: 'https://a.test/y' })).toBe('https://a.test/y')
  })

  it('names a download from its file name, else its address', () => {
    expect(downloadName({ fileName: 'a.zip', finalUrl: 'https://a.test/b.zip', url: 'https://a.test/b.zip' })).toBe('a.zip')
    expect(downloadName({ fileName: null, finalUrl: 'https://a.test/files/my%20tool.tgz?x=1', url: '' })).toBe('my tool.tgz')
    expect(downloadName({ fileName: null, finalUrl: '', url: 'not a url' })).toBe('not a url')
  })

  it('marks a refused download as an error', () => {
    expect(downloadTone('REFUSED')).toBe('danger')
    expect(downloadTone('QUARANTINED')).toBe('warning')
    expect(downloadTone('REMOVED')).toBe('neutral')
  })

  it('says where code runs Restricted that it is no containment against hostile code', () => {
    expect(projectCodeAdvice({ effective: 'RESTRICTED', usable: true })).toMatch(/not a containment against hostile code/)
    expect(projectCodeAdvice({ effective: 'ISOLATED', usable: true })).toBeNull()
    expect(projectCodeAdvice({ effective: 'RESTRICTED', usable: false })).toBeNull()
  })
})
