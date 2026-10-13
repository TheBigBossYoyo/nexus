import { describe, expect, it } from 'vitest'
import type { OperatorCommand } from '@shared/director-line'
import { interpretMessage } from '@main/modules/director-line/intent'
import type { PhoneAuthResult } from '@main/modules/director-line/pairing'
import { MAX_PIN_TRIES_PER_CALL, SESSION_IDLE_MS, VoiceSession, spokenDigits, type VoiceSessionStart } from '@main/modules/director-line/voice-session'

// 0.9.1: one telephone call with the Director. The telephone service is not here: the session is given what
// was said or pressed and answers with what to say. The PIN below is made up.
const OPERATOR = '+21620123456'
const PIN = '482915'

function session(start: Partial<VoiceSessionStart> = {}, over: { auth?: (from: string, pin: string | null) => PhoneAuthResult } = {}) {
  let now = 1_000_000
  const performed: { text: string; command: OperatorCommand; turnId: string }[] = []
  const notes: string[] = []
  const authCalls: (string | null)[] = []
  const s = new VoiceSession(
    { callId: 'CA1', direction: 'INBOUND', from: OPERATOR, ...start },
    {
      authenticatePhone: async (from, pin) => {
        authCalls.push(pin)
        if (over.auth) return over.auth(from, pin)
        return from !== OPERATOR ? 'WRONG_NUMBER' : pin === PIN ? 'OK' : 'WRONG_PIN'
      },
      isPairedNumber: async (from) => from === OPERATOR,
      interpret: async (text) => ({ text, command: await interpretMessage(text) }),
      perform: async (input) => {
        performed.push({ text: input.text, command: input.command, turnId: input.turnId })
        return input.command.kind === 'STATUS' || input.command.kind === 'DETAILS' ? 'RaceDeck: 73%, verifying. 25–40 min of active work remain. No blockers.' : input.command.kind === 'REFUSED_AT_MACHINE' ? 'That is decided at the machine, not from here.' : `did ${input.command.kind}`
      },
      now: () => now,
      note: (what) => notes.push(what),
    },
  )
  return { s, performed, notes, authCalls, advance: (ms: number) => (now += ms) }
}

const key = async (s: VoiceSession, digits: string) => {
  let last = null
  for (const d of `${digits}#`) last = await s.onDigit(d)
  return last
}

describe('digits as a caller says them', () => {
  it('reads spoken and typed digits, in English and French, and nothing else', () => {
    expect(spokenDigits('four eight two nine one five')).toBe('482915')
    expect(spokenDigits('4 8 2 9 1 5')).toBe('482915')
    expect(spokenDigits('482915.')).toBe('482915')
    expect(spokenDigits('quatre huit deux neuf un cinq')).toBe('482915')
    expect(spokenDigits('oh one')).toBe('01')
    expect(spokenDigits('what is the status')).toBeNull()
    expect(spokenDigits('four eight two status')).toBeNull()
    expect(spokenDigits('')).toBeNull()
  })
})

describe('a call that comes in', () => {
  it('asks for the PIN first and answers nothing before it: not a status, not a task', async () => {
    const w = session()
    expect((await w.s.open()).say).toContain('What is the PIN?')
    expect(await w.s.onSpeech('what is the status')).toEqual({ say: 'The PIN first, please.', end: false })
    expect(await w.s.onSpeech('add a task after this: delete everything')).toEqual({ say: 'The PIN first, please.', end: false })
    expect(w.performed).toEqual([])
    expect(w.s.isAuthenticated).toBe(false)
  })

  it('with the PIN keyed in, a status is answered from what the runtime computed', async () => {
    const w = session()
    await w.s.open()
    expect(await key(w.s, PIN)).toEqual({ say: 'Thank you. What would you like to know?', end: false })
    const reply = await w.s.onSpeech('How is RaceDeck going?')
    expect(reply.say).toBe('RaceDeck: 73%, verifying. 25–40 min of active work remain. No blockers.')
    expect(w.performed[0]?.command).toEqual({ kind: 'DETAILS', subject: 'RaceDeck' })
  })

  it('the PIN can be said instead of keyed', async () => {
    const w = session()
    await w.s.open()
    expect((await w.s.onSpeech('four eight two nine one five')).say).toContain('Thank you')
    expect(w.s.isAuthenticated).toBe(true)
  })

  it('a wrong PIN is refused, and the third ends the call', async () => {
    const w = session()
    await w.s.open()
    expect(await key(w.s, '111111')).toEqual({ say: 'That is not right. Try again.', end: false })
    expect(await key(w.s, '222222')).toEqual({ say: 'That is not right. Try again.', end: false })
    expect(await key(w.s, '333333')).toEqual({ say: 'That is not right. Goodbye.', end: true })
    expect(MAX_PIN_TRIES_PER_CALL).toBe(3)
    expect(w.s.isAuthenticated).toBe(false)
    // After the end nothing more is answered, not even the right PIN.
    expect(await w.s.onSpeech('status')).toEqual({ say: '', end: true })
    expect(await key(w.s, PIN)).toBeNull()
    expect(w.performed).toEqual([])
    expect(w.notes.filter((n) => n.includes('wrong PIN'))).toHaveLength(3)
    expect(w.notes.join(' ')).not.toContain('111111')
  })

  it('a number that is locked out is ended at its next try, whatever it keys', async () => {
    const w = session({}, { auth: () => 'LOCKED' })
    await w.s.open()
    expect(await key(w.s, PIN)).toEqual({ say: 'That is not right. Goodbye.', end: true })
  })

  it('a caller whose number is not paired is told nothing and the call ends at once', async () => {
    const w = session({ from: '+15550001111' })
    const opened = await w.s.open()
    expect(opened).toEqual({ say: 'This number is not available. Goodbye.', end: true })
    expect(opened.say).not.toMatch(/NEXUS|PIN/)
    expect(await w.s.onSpeech('status')).toEqual({ say: '', end: true })
    expect(w.performed).toEqual([])
    // The attempt counts against that number.
    expect(w.authCalls).toEqual([null])
  })

  it('without a PIN set on the machine, nobody gets in', async () => {
    const w = session({}, { auth: () => 'NO_PIN_SET' })
    await w.s.open()
    expect((await key(w.s, PIN))?.end).toBe(true)
  })

  it('a task is read back and added only on a yes; a no adds nothing; another sentence drops it', async () => {
    const w = session()
    await w.s.open()
    await key(w.s, PIN)
    const asked = await w.s.onSpeech('after this add improve the telemetry panel and test it at 4K')
    expect(asked.say).toMatch(/^I heard a task after the current work: improve the telemetry panel and test it at 4K\. Shall I add it\?/)
    expect(w.performed).toEqual([])
    expect((await w.s.onSpeech('yes')).say).toBe('did ADD_TASK_AFTER_CURRENT')
    expect(w.performed).toHaveLength(1)

    await w.s.onSpeech('after this add rewrite the importer')
    expect(await w.s.onSpeech('no')).toEqual({ say: 'Cancelled. Nothing was added.', end: false })
    expect(w.performed).toHaveLength(1)

    await w.s.onSpeech('after this add rewrite the importer')
    await w.s.onSpeech('what is the status')
    expect(w.performed.map((p) => p.command.kind)).toEqual(['ADD_TASK_AFTER_CURRENT', 'STATUS'])
    // The yes that comes late creates nothing: the question is gone.
    await w.s.onSpeech('yes')
    expect(w.performed.filter((p) => p.command.kind === 'ADD_TASK_AFTER_CURRENT')).toHaveLength(1)
  })

  it('what needs the machine is refused on the phone as by message, and noted', async () => {
    const w = session()
    await w.s.open()
    await key(w.s, PIN)
    for (const ask of ['push the repository', 'disable the sandbox', 'allow the pending boundary request', 'shut down the computer']) {
      expect((await w.s.onSpeech(ask)).say, ask).toBe('That is decided at the machine, not from here.')
    }
    expect(w.performed.every((p) => p.command.kind === 'REFUSED_AT_MACHINE')).toBe(true)
    expect(w.notes.filter((n) => n.includes('refused'))).toHaveLength(4)
  })

  it('a call left open is not an open door: after five idle minutes it ends', async () => {
    const w = session()
    await w.s.open()
    await key(w.s, PIN)
    w.advance(SESSION_IDLE_MS + 1000)
    expect((await w.s.onSpeech('status')).end).toBe(true)
    expect(w.performed).toEqual([])
  })

  it('goodbye ends the call; each turn has its own number, so a turn delivered twice can be told', async () => {
    const w = session()
    await w.s.open()
    await key(w.s, PIN)
    await w.s.onSpeech('status')
    await w.s.onSpeech('how long is left')
    expect(w.performed.map((p) => p.turnId)).toEqual(['1', '2'])
    expect(await w.s.onSpeech('goodbye')).toEqual({ say: 'Goodbye.', end: true })
  })

  it('the star key clears what was keyed', async () => {
    const w = session()
    await w.s.open()
    for (const d of '999') await w.s.onDigit(d)
    await w.s.onDigit('*')
    expect((await key(w.s, PIN))?.say).toContain('Thank you')
  })
})

describe('a call NEXUS places', () => {
  const report = 'Overnight completed 16 of 18 tasks. Two tasks were delayed by a 19 minute Wi-Fi outage and resumed by themselves.'

  it('says its report first and answers questions about the work without a PIN', async () => {
    const w = session({ direction: 'OUTBOUND', report })
    const opened = await w.s.open()
    expect(opened.say).toContain('This is NEXUS. Overnight completed 16 of 18 tasks.')
    expect(opened.end).toBe(false)
    expect((await w.s.onSpeech('how long is left')).say).toBe('did ETA')
    expect(w.s.isAuthenticated).toBe(false)
  })

  it('asks for the PIN before anything that changes work, then does what was asked', async () => {
    const w = session({ direction: 'OUTBOUND', report })
    await w.s.open()
    expect((await w.s.onSpeech('pause after the current task')).say).toContain('The PIN is needed for that')
    expect(w.performed).toEqual([])
    expect((await key(w.s, PIN))?.say).toBe('did PAUSE_AFTER_CURRENT_TASK')
    // A task asked before the PIN is read back after it, and still waits for a yes.
    const w2 = session({ direction: 'OUTBOUND', report })
    await w2.s.open()
    await w2.s.onSpeech('after this add improve the telemetry panel')
    expect((await w2.s.onSpeech('four eight two nine one five')).say).toMatch(/^I heard a task after the current work: improve the telemetry panel/)
    expect(w2.performed).toEqual([])
    await w2.s.onSpeech('oui')
    expect(w2.performed.map((p) => p.command.kind)).toEqual(['ADD_TASK_AFTER_CURRENT'])
  })

  it('whoever picked up the phone and does not know the PIN changes nothing', async () => {
    const w = session({ direction: 'OUTBOUND', report })
    await w.s.open()
    await w.s.onSpeech('continue')
    await key(w.s, '000000')
    await key(w.s, '000001')
    expect((await key(w.s, '000002'))?.end).toBe(true)
    expect(w.performed).toEqual([])
  })
})
