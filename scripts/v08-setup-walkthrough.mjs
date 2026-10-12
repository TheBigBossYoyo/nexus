// 0.8: the one-time setup of the isolated profile, from the real window, with the user present. The window is
// visible, the confirmation is NEXUS's own dialog and the elevation is Windows's own prompt: this script presses
// the button a user would press and answers nothing. To be run on a machine that has no sandbox account.
//
//   node scripts/v08-setup-walkthrough.mjs
import { _electron as electron } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stopNexus, waitForRuntime } from './acceptance-common.mjs'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'test-results', 'v08-setup')
const dataDir = join(output, 'data')
rmSync(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
mkdirSync(output, { recursive: true })
const evidence = { kind: 'v0.8-in-app-setup', startedAt: new Date().toISOString(), checks: {}, errors: [] }
const env = { ...process.env, NEXUS_DATA_DIR: dataDir }
for (const name of ['NEXUS_FAKE_RUNTIME', 'NEXUS_FAKE_POWER', 'NEXUS_FAKE_WORKERS', 'NEXUS_CONTAINMENT', 'NEXUS_ACCEPT_CONFIRM', 'NEXUS_WINDOW_OFFSCREEN']) delete env[name]
const brief = (s) => ({ requested: s.requested, effective: s.effective, usable: s.usable, detail: s.detail, isolated: s.isolated, restricted: s.restricted, sandboxAccount: s.sandboxAccount, setupAvailable: s.setupAvailable })

const app = await electron.launch({ args: ['.'], cwd: root, env })
try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => evidence.errors.push(error.message))
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 90_000 })
  await waitForRuntime(page)
  const call = async (channel, input = {}) => {
    const result = await page.evaluate(([c, i]) => globalThis.nexus.invoke(c, i), [channel, input])
    if (!result.ok) throw new Error(`${channel}: ${result.error.code} ${result.error.message}`)
    return result.value
  }
  const before = await call('isolation.status')
  evidence.before = brief(before)
  evidence.checks['before: no sandbox account, the setup is offered, ISOLATED is not available'] = !before.sandboxAccount && before.setupAvailable === true && before.isolated?.available !== true

  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-autonomy').click()
  await page.getByTestId('isolation-panel').waitFor({ state: 'visible', timeout: 30_000 })
  const button = page.getByTestId('isolation-setup-button')
  await button.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, 'before.png'), fullPage: true })
  evidence.checks['the button is shown'] = await button.isVisible()
  console.log('pressing "Set up the isolated profile…": the confirmation and the Windows prompt are the user\'s to answer')
  await button.click()
  const result = page.getByTestId('isolation-setup-result')
  await page.waitForFunction(() => (globalThis.document.querySelector('[data-testid="isolation-setup-result"]')?.textContent ?? '').trim() !== '', null, { timeout: 12 * 60_000 })
  evidence.resultText = (await result.textContent())?.trim()
  // The verification of the profile runs the launcher as the new account; give it its time.
  let after = await call('isolation.status')
  for (let i = 0; i < 60 && !(after.sandboxAccount && after.isolated?.available === true); i += 1) {
    await page.waitForTimeout(2000)
    after = await call('isolation.status')
  }
  evidence.after = brief(after)
  evidence.checks['after: the sandbox account is recorded'] = Boolean(after.sandboxAccount)
  evidence.checks['after: ISOLATED was verified by running it and is available'] = after.isolated?.available === true
  evidence.checks['after: the panel says the account is set up and offers no button'] = (await page.getByTestId('isolation-setup').textContent())?.includes('The sandbox account is set up for this user.') === true && (await button.count()) === 0
  await page.screenshot({ path: join(output, 'after.png'), fullPage: true })
  evidence.checks['the window reported no script error'] = evidence.errors.length === 0
} catch (error) {
  evidence.failure = String(error?.stack ?? error).slice(0, 2000)
  console.error(error)
} finally {
  await stopNexus(app, dataDir).catch((e) => evidence.errors.push(`stop: ${String(e)}`))
  evidence.finishedAt = new Date().toISOString()
  evidence.verdict = evidence.failure === undefined && Object.values(evidence.checks).every(Boolean) ? 'PASS' : 'FAIL'
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
  for (const [name, ok] of Object.entries(evidence.checks)) console.log(ok ? 'PASS' : 'FAIL', name)
  console.log('result:', evidence.resultText)
  console.log(evidence.verdict, join(output, 'evidence.json'))
  if (evidence.verdict !== 'PASS') process.exitCode = 1
}
