import { describe, expect, it } from 'vitest'
import { normalizeSipIdentity, type CallSecurityView } from '@shared/director-line'
import type { DirectorLineView } from '@shared/ipc'
import { normalizeSipIdentity as providerNormalize } from '@main/modules/director-line/voice-provider'
import {
  EMPTY_SIP_FORM, answerTimeWords, callMeDisabledReason, clock, isValidTimeZone, liveSecurityWords, minuteToTime, moved, placeResultWords, sameVoicePolicy, secondsLeft, securityText, sipFormFromView, sipFormInput,
  sipFormProblems, speechLine, timeToMinute, voicePolicyProblems, voiceStatus, type SipForm,
} from '../../../src/renderer/src/views/settings/directorLineModel'

describe('director line settings model', () => {
  it('converts between minutes and clock text', () => {
    expect(minuteToTime(22 * 60 + 30)).toBe('22:30')
    expect(minuteToTime(7 * 60)).toBe('07:00')
    expect(timeToMinute('22:30')).toBe(1350)
    expect(timeToMinute('24:00')).toBeNull()
    expect(timeToMinute('7:00')).toBeNull()
  })

  it('knows a time zone from a typo', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Europe/Pariss')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })

  it('counts a pairing window down and never below zero', () => {
    const at = Date.parse('2026-10-13T12:10:00.000Z')
    expect(secondsLeft('2026-10-13T12:10:00.000Z', at - 125_000)).toBe(125)
    expect(clock(125)).toBe('2:05')
    expect(secondsLeft('2026-10-13T12:10:00.000Z', at + 5000)).toBe(0)
  })

  it('moves a channel earlier or later and stops at the ends', () => {
    expect(moved(['PHONE', 'MESSAGE', 'LOCAL_NOTIFICATION'], 1, -1)).toEqual(['MESSAGE', 'PHONE', 'LOCAL_NOTIFICATION'])
    expect(moved(['PHONE', 'MESSAGE', 'LOCAL_NOTIFICATION'], 2, 1)).toEqual(['PHONE', 'MESSAGE', 'LOCAL_NOTIFICATION'])
  })
})

describe('voice (SIP) form and words', () => {
  const voice = (over: Partial<DirectorLineView['voice']> = {}): DirectorLineView['voice'] => ({
    available: true,
    unavailableReason: null,
    configured: true,
    identity: 'sip:nexus@sip.linphone.org',
    passwordSet: true,
    operatorIdentity: 'sip:me@sip.linphone.org',
    state: 'REGISTERED',
    stateDetail: null,
    inCall: false,
    callSecurity: null,
    mediaEncryption: 'zrtp',
    mediaEncryptionMandatory: true,
    stunServer: null,
    ice: false,
    policy: { requirePin: true, ringSeconds: 30, maxPlacedCallsPerDay: 6, minMinutesBetweenPlacedCalls: 10 },
    speech: { stt: { kind: 'whisper', local: true }, tts: { kind: 'piper', local: true } },
    lastCalls: [],
    ...over,
  })

  it('the shared normaliser agrees with the one of the voice provider', () => {
    const texts = ['sip:Me@SIP.Linphone.org', '<sip:me@sip.linphone.org;transport=tls>', 'me@sip.linphone.org', '"Me" <sips:me@sip.linphone.org:5061>', 'me@localhost', 'sip:@x.org', 'not a sip', '', 'sip:a b@c.org']
    for (const text of texts) expect(normalizeSipIdentity(text), text).toBe(providerNormalize(text))
  })

  it('validates the form; an empty password keeps the stored one only when there is one', () => {
    const form: SipForm = { ...EMPTY_SIP_FORM, identity: 'sip:nexus@sip.linphone.org', operatorIdentity: 'sip:me@sip.linphone.org', password: 'secret-pw' }
    expect(sipFormProblems(form, false)).toEqual({})
    expect(sipFormProblems({ ...form, password: '' }, true)).toEqual({})
    expect(sipFormProblems({ ...form, password: '' }, false)).toHaveProperty('password')
    expect(sipFormProblems({ ...form, identity: 'nexus' }, false)).toHaveProperty('identity')
    expect(sipFormProblems({ ...form, operatorIdentity: 'sip:NEXUS@sip.linphone.org' }, false)).toHaveProperty('operatorIdentity')
    expect(sipFormProblems({ ...form, stunServer: 'not a host!' }, false)).toHaveProperty('stunServer')
    expect(sipFormProblems({ ...form, stunServer: 'stun.example.org:3478' }, false)).toEqual({})
    expect(sipFormProblems({ ...form, password: 'x'.repeat(129) }, false)).toHaveProperty('password')
  })

  it('sends only what was typed: an empty password is null, an empty STUN server is null', () => {
    const form: SipForm = { ...EMPTY_SIP_FORM, identity: ' sip:nexus@sip.linphone.org ', operatorIdentity: 'sip:me@sip.linphone.org' }
    expect(sipFormInput(form)).toEqual({
      identity: 'sip:nexus@sip.linphone.org', password: null, operatorIdentity: 'sip:me@sip.linphone.org', mediaEncryption: 'zrtp', mediaEncryptionMandatory: true, stunServer: null, ice: false,
    })
    expect(sipFormInput({ ...form, password: 'pw', stunServer: ' stun.example.org ' })).toMatchObject({ password: 'pw', stunServer: 'stun.example.org' })
  })

  it('the form starts from the view and never from a password', () => {
    expect(sipFormFromView(voice({ stunServer: 'stun.example.org', mediaEncryption: 'dtls' }))).toEqual({
      identity: 'sip:nexus@sip.linphone.org', password: '', operatorIdentity: 'sip:me@sip.linphone.org', mediaEncryption: 'dtls', mediaEncryptionMandatory: true, stunServer: 'stun.example.org', ice: false,
    })
  })

  it('checks the ranges of the call settings', () => {
    const ok = { requirePin: true, ringSeconds: 30, maxPlacedCallsPerDay: 6, minMinutesBetweenPlacedCalls: 10 }
    expect(voicePolicyProblems(ok)).toEqual({})
    expect(voicePolicyProblems({ ...ok, ringSeconds: 9 })).toHaveProperty('ringSeconds')
    expect(voicePolicyProblems({ ...ok, ringSeconds: 61 })).toHaveProperty('ringSeconds')
    expect(voicePolicyProblems({ ...ok, maxPlacedCallsPerDay: 25 })).toHaveProperty('maxPlacedCallsPerDay')
    expect(voicePolicyProblems({ ...ok, maxPlacedCallsPerDay: 0, minMinutesBetweenPlacedCalls: 0 })).toEqual({})
    expect(voicePolicyProblems({ ...ok, minMinutesBetweenPlacedCalls: 241 })).toHaveProperty('minMinutesBetweenPlacedCalls')
    expect(voicePolicyProblems({ ...ok, ringSeconds: 12.5 })).toHaveProperty('ringSeconds')
    expect(sameVoicePolicy(ok, { ...ok })).toBe(true)
    expect(sameVoicePolicy(ok, { ...ok, requirePin: false })).toBe(false)
  })

  it('says the state of the line in words', () => {
    expect(voiceStatus(voice({ available: false, unavailableReason: 'No SIP helper was built.' })).text).toBe('Not available on this build: No SIP helper was built.')
    expect(voiceStatus(voice({ configured: false })).text).toBe('Not set up')
    expect(voiceStatus(voice({ state: 'CONNECTING' })).text).toBe('Connecting')
    expect(voiceStatus(voice()).text).toBe('Registered as sip:nexus@sip.linphone.org')
    expect(voiceStatus(voice({ state: 'UNREACHABLE' })).text).toBe('Unreachable')
    expect(voiceStatus(voice({ state: 'REJECTED' })).text).toBe('Rejected (wrong password)')
    expect(voiceStatus(voice({ inCall: true })).text).toBe('In a call')
    expect(voiceStatus(voice({ state: 'STOPPED', stateDetail: 'The Director Line is off.' })).text).toBe('Not running: The Director Line is off.')
  })

  it('"Call me now" says why it cannot be pressed', () => {
    expect(callMeDisabledReason(voice())).toBeNull()
    expect(callMeDisabledReason(voice({ available: false }))).toMatch(/not available/)
    expect(callMeDisabledReason(voice({ configured: false }))).toMatch(/not set up/)
    expect(callMeDisabledReason(voice({ operatorIdentity: null }))).toMatch(/SIP address is not set/)
    expect(callMeDisabledReason(voice({ inCall: true }))).toMatch(/in a call/)
    expect(callMeDisabledReason(voice({ state: 'UNREACHABLE' }))).toMatch(/not registered/)
  })

  it('says what is the case in a call in progress, and offers the confirmation only for a ZRTP code that was not compared', () => {
    const sec = (over: Partial<CallSecurityView>): CallSecurityView => ({ signalling: 'TLS', media: 'ZRTP', endToEnd: false, peerVerified: false, sas: 'AB12', ...over })
    expect(liveSecurityWords(sec({}))).toEqual({ text: 'Encrypted (ZRTP). Verification code: AB12. Compare it with the code Linphone shows on the telephone.', canConfirm: true })
    expect(liveSecurityWords(sec({ peerVerified: true, endToEnd: true })).canConfirm).toBe(false)
    expect(liveSecurityWords(sec({ peerVerified: true, endToEnd: true })).text).toContain('verified end to end')
    expect(liveSecurityWords(sec({ sas: null })).canConfirm).toBe(false)
    expect(liveSecurityWords(sec({ media: 'SRTP', sas: null }))).toEqual({ text: 'Encrypted (SRTP). The keys are known to the SIP server.', canConfirm: false })
    expect(liveSecurityWords(sec({ media: 'NONE', sas: null }))).toEqual({ text: 'Not encrypted.', canConfirm: false })
    expect(EMPTY_SIP_FORM.ice).toBe(false)
  })

  it('shows what a call negotiated exactly as it was recorded, and what speech leaves the PC', () => {
    expect(securityText({ signalling: 'TLS', media: 'ZRTP', endToEnd: true, peerVerified: true, sas: null })).toBe('TLS to the server / ZRTP, verified end to end')
    expect(securityText({ signalling: 'TLS', media: 'ZRTP', endToEnd: false, peerVerified: false, sas: null })).toBe('TLS to the server / ZRTP, not verified')
    expect(securityText({ signalling: 'TLS', media: 'SRTP', endToEnd: false, peerVerified: false, sas: null })).toBe('TLS to the server / SRTP (keys known to the server)')
    expect(securityText({ signalling: 'TLS', media: 'NONE', endToEnd: false, peerVerified: false, sas: null })).toBe('not encrypted')
    expect(securityText({ signalling: 'TLS', media: 'DTLS_SRTP', endToEnd: false, peerVerified: false, sas: null })).toBe('TLS to the server / DTLS-SRTP (fingerprints through the server)')
    expect(securityText({ signalling: 'NONE', media: 'UNKNOWN', endToEnd: false, peerVerified: false, sas: null })).toBe('no TLS to the server / media unknown')
    expect(securityText(null)).toBe('not recorded')
    expect(speechLine({ stt: { kind: 'whisper', local: true }, tts: { kind: 'piper', local: true } })).toBe('Recogniser: whisper (on this PC). Voice: piper (on this PC).')
    expect(speechLine({ stt: { kind: 'deepgram', local: false }, tts: { kind: 'piper', local: true } })).toContain('sound goes to deepgram')
    expect(speechLine({ stt: null, tts: null })).toBe('No speech engine is installed, so calls cannot be held yet.')
    expect(answerTimeWords(1234)).toBe('1.2 s')
    expect(answerTimeWords(null)).toBe('not measured')
    expect(placeResultWords('NO_ANSWER')).toMatch(/No answer/)
  })
})
