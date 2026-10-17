import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createTargetInspector } from '@main/modules/privilege/inspect'
import type { PrivilegedOperationRequest } from '@shared/privilege'

// Opt-in: the real Get-AuthenticodeSignature, unelevated, on this machine. NEXUS_TEST_AUTHENTICODE=1 on Windows.
const enabled = process.env['NEXUS_TEST_AUTHENTICODE'] === '1' && process.platform === 'win32'

describe.skipIf(!enabled)('real Authenticode inspection', () => {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  const dir = enabled ? mkdtempSync(join(tmpdir(), 'nexus-inspect-')) : ''
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const inspect = createTargetInspector({ systemRoot })
  const req = (executable: string): PrivilegedOperationRequest => ({ executable, args: [] }) as unknown as PrivilegedOperationRequest

  it('names the signer of notepad.exe and says the signature is valid', async () => {
    const [out] = await inspect(req(join(systemRoot, 'System32', 'notepad.exe')))
    expect(out).toMatch(/signed by .+, signature valid/)
  })

  it('does not call an unsigned file valid', async () => {
    const file = join(dir, 'unsigned.exe')
    writeFileSync(file, 'MZ not a real program')
    const [out] = await inspect(req(file))
    expect(out).not.toMatch(/signature valid/)
    expect(out).toMatch(/unsigned|NOT valid|could not be checked/)
  })
})
