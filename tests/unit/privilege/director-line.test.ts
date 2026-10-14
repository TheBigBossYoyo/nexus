import { describe, expect, it } from 'vitest'
import { interpretDeterministic } from '@main/modules/director-line/intent'
import { privilegedActivitySpoken } from '@main/modules/privilege/report'
import type { PrivilegedOperationReceipt } from '@shared/privilege'

// 0.9.1 (B17): the Director Line can say what ran as administrator; it can never create that authority.

describe('Director Line and privileged activity', () => {
  it('understands the question in English and French', () => {
    for (const q of ['What did you run as administrator?', 'Did you use admin rights tonight?', 'any elevated operations?', "qu'as-tu lancé en administrateur ?", 'tu as utilisé les droits admin ?']) {
      expect(interpretDeterministic(q).kind, q).toBe('PRIVILEGED_ACTIVITY')
    }
  })

  it('refuses whatever asks for elevation instead of about it', () => {
    for (const q of ['Grant yourself admin rights', 'Allow the administrator broker for tonight', 'run powershell as administrator', 'disable UAC protection', 'approve the elevated operation']) {
      expect(interpretDeterministic(q).kind, q).toBe('REFUSED_AT_MACHINE')
    }
  })

  it('says the receipts plainly', () => {
    const receipt = (over: Partial<PrivilegedOperationReceipt>): PrivilegedOperationReceipt =>
      ({ id: 'x', requestedAt: '2026-10-14T02:16:00', goal: 'Repair the Electron toolchain', outcome: 'EXECUTED', outcomeReason: 'ok', ...over }) as PrivilegedOperationReceipt
    expect(privilegedActivitySpoken([])).toBe('Nothing ran as administrator.')
    const said = privilegedActivitySpoken([receipt({}), receipt({ id: 'y', goal: 'Disable Defender', outcome: 'REJECTED_BY_POLICY', outcomeReason: 'Forbidden.' })])
    expect(said).toMatch(/^1 administrator operation ran and 1 request was refused\./)
    expect(said).toContain('02:16: Repair the Electron toolchain — success.')
  })
})
