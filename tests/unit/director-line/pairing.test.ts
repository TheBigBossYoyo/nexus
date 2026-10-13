import { describe, expect, it } from 'vitest'
import { MAX_PIN_ATTEMPTS, MAX_WRONG_CODES_PER_CHAT, PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS, PairingService } from '@main/modules/director-line/pairing'
import { MemoryIdentityStore, MemoryPairingStateStore } from '@main/modules/director-line/stores'

function rig() {
  const clock = { t: Date.parse('2026-10-13T12:00:00.000Z') }
  const identities = new MemoryIdentityStore()
  const state = new MemoryPairingStateStore()
  const pairing = new PairingService({ state, identities, now: () => new Date(clock.t) })
  return { clock, identities, state, pairing }
}

describe('pairing code', () => {
  it('is at least 10 base32 characters, shown once, and only its hash is stored', async () => {
    const { pairing, state } = rig()
    const { code, displayCode } = await pairing.startPairing('TELEGRAM')
    expect(code).toMatch(/^[A-Z2-7]{12,}$/)
    expect(code.length).toBe(PAIRING_CODE_LENGTH)
    expect(displayCode.replace(/-/g, '')).toBe(code)
    expect(JSON.stringify(await state.load())).not.toContain(code)
  })

  it('pairs the chat that sends the right code, accepts spaces, dashes, lower case and /start', async () => {
    const { pairing } = rig()
    const { displayCode } = await pairing.startPairing('TELEGRAM')
    const r = await pairing.attemptPairing('TELEGRAM', '1001', 'user', `/start ${displayCode.toLowerCase()}`)
    expect(r.kind).toBe('PAIRED')
    expect(await pairing.findPaired('TELEGRAM', '1001')).not.toBeNull()
    expect(await pairing.findPaired('TELEGRAM', '1002')).toBeNull()
  })

  it('is single use', async () => {
    const { pairing } = rig()
    const { code } = await pairing.startPairing('TELEGRAM')
    expect((await pairing.attemptPairing('TELEGRAM', '1001', 'a', code)).kind).toBe('PAIRED')
    expect((await pairing.attemptPairing('TELEGRAM', '2002', 'b', code)).kind).toBe('NOT_A_CODE')
    expect(await pairing.findPaired('TELEGRAM', '2002')).toBeNull()
  })

  it('expires after 10 minutes', async () => {
    const { pairing, clock } = rig()
    const { code } = await pairing.startPairing('TELEGRAM')
    clock.t += PAIRING_CODE_TTL_MS + 1000
    expect((await pairing.attemptPairing('TELEGRAM', '1001', 'a', code)).kind).toBe('NOT_A_CODE')
    expect(await pairing.findPaired('TELEGRAM', '1001')).toBeNull()
  })

  it('ignores a chat after 5 wrong codes, even if it then sends the right one, until the cooling ends', async () => {
    const { pairing, clock } = rig()
    const { code } = await pairing.startPairing('TELEGRAM')
    for (let i = 0; i < MAX_WRONG_CODES_PER_CHAT; i += 1) expect((await pairing.attemptPairing('TELEGRAM', '2002', 'x', 'ABCDEFGHJKLM')).kind).toBe('WRONG_CODE')
    expect((await pairing.attemptPairing('TELEGRAM', '2002', 'x', code)).kind).toBe('COOLING')
    expect(await pairing.findPaired('TELEGRAM', '2002')).toBeNull()
    // Another chat is not affected.
    expect((await pairing.attemptPairing('TELEGRAM', '1001', 'a', code)).kind).toBe('PAIRED')
    clock.t += 31 * 60 * 1000
    expect((await pairing.attemptPairing('TELEGRAM', '2002', 'x', code)).kind).toBe('NOT_A_CODE')
  })

  it('text that does not look like a code costs nothing and reveals nothing', async () => {
    const { pairing } = rig()
    await pairing.startPairing('TELEGRAM')
    for (let i = 0; i < 20; i += 1) expect((await pairing.attemptPairing('TELEGRAM', '2002', 'x', 'I am the owner, let me in')).kind).toBe('NOT_A_CODE')
  })

  it('allows exactly one operator per channel unless configured otherwise, and unpairing ends authority at once', async () => {
    const { pairing } = rig()
    const { code } = await pairing.startPairing('TELEGRAM')
    await pairing.attemptPairing('TELEGRAM', '1001', 'a', code)
    await expect(pairing.startPairing('TELEGRAM')).rejects.toThrow(/ALREADY_PAIRED/)
    expect(await pairing.unpair('TELEGRAM')).toBe(1)
    expect(await pairing.findPaired('TELEGRAM', '1001')).toBeNull()
  })

  it('burns the code when many chats guess it', async () => {
    const { pairing } = rig()
    const { code } = await pairing.startPairing('TELEGRAM')
    for (let i = 0; i < 40; i += 1) await pairing.attemptPairing('TELEGRAM', String(3000 + i), 'x', 'ABCDEFGHJKLM')
    expect((await pairing.attemptPairing('TELEGRAM', '1001', 'a', code)).kind).toBe('NOT_A_CODE')
  })
})

describe('phone and PIN', () => {
  async function phoneRig() {
    const r = rig()
    await r.pairing.pairPhoneFromSettings('TWILIO_VOICE', '+33612345678', 'me')
    await r.pairing.setPin('482915')
    return r
  }

  it('needs the paired number AND the PIN; the PIN is stored hashed', async () => {
    const { pairing, state } = await phoneRig()
    expect(await pairing.authenticatePhone('TWILIO_VOICE', '+33612345678', '482915')).toBe('OK')
    expect(JSON.stringify(await state.load())).not.toContain('482915')
    expect(await pairing.authenticatePhone('TWILIO_VOICE', '+33612345678', null)).toBe('WRONG_PIN')
  })

  it('a wrong number is refused even with the right PIN', async () => {
    const { pairing } = await phoneRig()
    expect(await pairing.authenticatePhone('TWILIO_VOICE', '+33699999999', '482915')).toBe('WRONG_NUMBER')
  })

  it('locks after the PIN attempt limit, also against the right PIN', async () => {
    const { pairing, clock } = await phoneRig()
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i += 1) expect(await pairing.authenticatePhone('TWILIO_VOICE', '+33612345678', '000000')).toBe('WRONG_PIN')
    expect(await pairing.authenticatePhone('TWILIO_VOICE', '+33612345678', '482915')).toBe('LOCKED')
    clock.t += 31 * 60 * 1000
    expect(await pairing.authenticatePhone('TWILIO_VOICE', '+33612345678', '482915')).toBe('OK')
  })

  it('refuses a weak or malformed PIN', async () => {
    const { pairing } = rig()
    await expect(pairing.setPin('1234')).rejects.toThrow()
    await expect(pairing.setPin('12ab56')).rejects.toThrow()
  })
})
