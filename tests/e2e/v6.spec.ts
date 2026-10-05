import { expect, test, type Page } from '@playwright/test'
import { closeApp, createRepo, dismissApprovalDrawer, invoke, launchApp, removeDir, screenshot, tempDir } from './helpers'

/**
 * NEXUS 0.6 against the built app with scripted providers: the Providers page, enabling a provider and
 * cross-model review through the UI, a mission whose reviews are done by the other provider while Claude
 * implements, and a provider that needs authentication. No real provider is reached.
 */
async function runMission(page: Page): Promise<string> {
  await page.getByTestId('nav-projects').click()
  await page.getByTestId('open-project').click()
  await expect(page.getByTestId('project-detail')).toBeVisible()
  await page.getByTestId('mission-prompt').fill('Add an API module and a UI module, then integrate them.')
  await page.getByTestId('mode-select').selectOption('build')
  await page.getByTestId('strategy-select').selectOption('BUILD')
  await page.getByTestId('preset-select').selectOption('balanced')
  await page.getByTestId('create-run').click()
  await expect(page.getByTestId('run-view')).toBeVisible()
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'awaiting_approval')
  await dismissApprovalDrawer(page)
  await page.getByTestId('plan-panel').getByTestId('approve-plan').click()
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'completed', { timeout: 180_000 })
  const run = (await invoke(page, 'runs.list', {}))[0]
  if (!run) throw new Error('No run')
  return run.id
}

test.describe('NEXUS 0.6 providers', () => {
  const dirs: string[] = []
  test.afterAll(() => {
    for (const d of dirs) removeDir(d)
  })

  test('the Providers page; cross-model review: Claude implements, the other provider reviews, Claude verifies', async () => {
    test.setTimeout(420_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await page.getByTestId('nav-providers').click()
      await expect(page.getByTestId('view-providers')).toBeVisible()
      await expect(page.getByTestId('provider-state-claude')).toHaveText('Connected')
      await expect(page.getByTestId('provider-state-codex')).toHaveText('Available, not enabled')
      await expect(page.getByTestId('provider-state-gemini')).toHaveText('Not installed')
      // Claude has no switch; a provider that is not installed cannot be enabled and says why.
      await expect(page.getByTestId('provider-enable-claude')).toHaveCount(0)
      await expect(page.getByTestId('provider-enable-gemini')).toBeDisabled()
      await expect(page.getByTestId('provider-enable-blocked-gemini')).toContainText('not installed')
      // No use can be switched on for a provider that is off.
      await expect(page.getByTestId('routing-review')).toBeDisabled()
      await expect(page.getByTestId('routing-review-blocked')).toHaveText('Enable Codex first.')
      await expect(page.getByTestId('providers-recent-empty')).toBeVisible()
      // A provider that reports no plan window has none shown, and no estimate.
      await expect(page.getByTestId('provider-usage-codex')).toContainText('not exposed by this runtime')
      await screenshot(page, 'v6-providers-default')

      await page.getByTestId('provider-enable-codex').click()
      await expect(page.getByTestId('provider-enable-codex')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('routing-review')).toBeEnabled()
      await page.getByTestId('routing-review').click()
      await expect(page.getByTestId('routing-review')).toHaveAttribute('aria-checked', 'true')
      const policy = (await invoke(page, 'providers.overview', {})).policy
      expect(policy).toMatchObject({ enabled: { claude: true, codex: true, gemini: false }, crossModelReview: { enabled: true, reviewer: 'codex' }, fallbackToClaude: true })
      // The explicit test session of a provider.
      await page.getByTestId('provider-probe-codex').click()
      await expect(page.getByTestId('provider-probe-result-codex')).toContainText('worked')
      await screenshot(page, 'v6-providers-enabled')

      const runId = await runMission(page)
      const sessions = await invoke(page, 'providers.sessions', { runId })
      const byRole = (role: string): string[] => [...new Set(sessions.filter((s) => s.role === role).map((s) => s.provider))]
      expect(byRole('reviewer')).toEqual(['codex'])
      expect(byRole('worker')).toEqual(['claude'])
      expect(byRole('planner')).toEqual(['claude'])
      expect(byRole('verifier')).toEqual(['claude'])
      expect(sessions.filter((s) => s.provider === 'codex').every((s) => s.model === 'scripted-codex' && s.outcome === 'completed' && s.fallbackReason === null)).toBe(true)
      expect(sessions.every((s) => s.outcome === 'completed')).toBe(true)
      // The mission itself went as it always does: a review asked for changes, a repair followed, a later review approved.
      const reviews = await invoke(page, 'reviews.list', { runId })
      expect(reviews.some((r) => r.verdict === 'changes_requested')).toBe(true)
      expect(reviews.some((r) => r.verdict === 'approved')).toBe(true)

      // The inspector says who ran each agent.
      await page.getByTestId('bottom-tab-agents').click()
      const reviewer = sessions.find((s) => s.provider === 'codex')
      await expect(page.getByTestId(`activity-provider-${reviewer?.agentId ?? ''}`)).toHaveAttribute('data-provider', 'Codex · scripted-codex')
      await screenshot(page, 'v6-mission-providers')

      await page.getByTestId('nav-providers').click()
      await expect(page.locator('[data-testid^="provider-session-"][data-provider="codex"]').first()).toBeVisible()
      await expect(page.getByTestId('provider-performance-codex')).toContainText('completed')
      await screenshot(page, 'v6-providers-after-mission')

      // Switching the provider off switches its use off, and the next sessions are Claude's again.
      await page.getByTestId('provider-enable-codex').click()
      await expect(page.getByTestId('provider-enable-codex')).toHaveAttribute('aria-checked', 'false')
      expect((await invoke(page, 'providers.overview', {})).policy).toMatchObject({ enabled: { codex: false }, crossModelReview: { enabled: false } })
    } finally {
      await closeApp(app)
    }
  })

  test('a provider that needs authentication cannot be enabled, in the UI or through the channel', async () => {
    test.setTimeout(180_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo, { NEXUS_FAKE_CODEX: 'auth' })
    try {
      await page.getByTestId('nav-providers').click()
      await expect(page.getByTestId('provider-state-codex')).toHaveText('Authentication required')
      await expect(page.getByTestId('provider-detail-codex')).toContainText('never handles its credentials')
      await expect(page.getByTestId('provider-enable-codex')).toBeDisabled()
      await expect(page.getByTestId('provider-probe-codex')).toHaveCount(0)
      await screenshot(page, 'v6-provider-auth-required')
      const overview = await invoke(page, 'providers.overview', {})
      const refused = await page.evaluate(
        async (policy) => (globalThis as unknown as { nexus: { invoke(c: string, i: object): Promise<{ ok: boolean; error?: { message: string } }> } }).nexus.invoke('providers.setPolicy', { policy }),
        { ...overview.policy, enabled: { claude: true, codex: true, gemini: false } },
      )
      expect(refused.ok).toBe(false)
      expect(refused.error?.message ?? '').toContain('not signed in')
      // NEXUS as a whole is unaffected: a mission runs on Claude alone.
      const runId = await runMission(page)
      const sessions = await invoke(page, 'providers.sessions', { runId })
      expect([...new Set(sessions.map((s) => s.provider))]).toEqual(['claude'])
    } finally {
      await closeApp(app)
    }
  })
})
