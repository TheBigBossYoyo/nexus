import { expect, test, type Page } from '@playwright/test'
import { closeApp, confirmationCount, countConfirmations, createRepo, invoke, launchApp, removeDir, screenshot, startBoundaryMission, tempDir } from './helpers'

/**
 * NEXUS 0.8 against the built app with the scripted runtime: enrolling a project from Settings, the boundary
 * inbox (answered with the mouse and with the keyboard alone), grants, the isolation panel and the panels of
 * the project page. Native confirmations are answered by the stub installed in the window. Nothing here sets up
 * the sandbox account: that would raise a Windows elevation prompt. No Claude usage.
 */
async function openProject(page: Page): Promise<string> {
  await page.getByTestId('nav-projects').click()
  await page.getByTestId('open-project').click()
  await expect(page.getByTestId('project-detail')).toBeVisible()
  const project = (await invoke(page, 'projects.list', {}))[0]
  if (!project) throw new Error('No project')
  return project.id
}

async function openAutonomySettings(page: Page): Promise<void> {
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-autonomy').click()
  await expect(page.getByTestId('autonomy-settings')).toBeVisible()
}

/** Presses Tab until the element with `testId` has the focus; fails after `limit` presses. */
async function tabTo(page: Page, testId: string, limit = 20): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await page.evaluate((id) => document.activeElement?.getAttribute('data-testid') === id, testId)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Focus did not reach ${testId} in ${limit} presses of Tab`)
}

test.describe('NEXUS 0.8 autonomy and isolation', () => {
  const dirs: string[] = []
  test.afterAll(() => {
    for (const d of dirs) removeDir(d)
  })

  test('a project is enrolled from Settings, narrowed without a question, widened with one, and stopped', async () => {
    test.setTimeout(240_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await countConfirmations(app)
      const projectId = await openProject(page)

      // Not enrolled: the project page says so and leads to the settings.
      await expect(page.getByTestId('project-autonomy-line')).toContainText('Not enrolled')
      await page.getByTestId('project-autonomy-open').click()
      await expect(page.getByTestId('autonomy-settings')).toBeVisible()
      await expect(page.getByTestId('autonomy-state')).toContainText('Not enrolled')
      await expect(page.getByTestId('autonomy-change')).toHaveCount(0)

      // Choosing a profile shows what it would allow before anything is changed.
      await page.getByTestId('autonomy-profile-AUTONOMOUS_PROJECT').check()
      await expect(page.getByTestId('autonomy-summary')).toContainText('If you choose Autonomous project')
      expect((await invoke(page, 'autonomy.overview', { projectId })).enrollment).toBeNull()

      // Enabling asks once, natively; the stub answers it.
      await page.getByTestId('autonomy-enable').click()
      await expect(page.getByTestId('autonomy-state')).toContainText('Enrolled: Autonomous project')
      expect(await confirmationCount(app)).toBe(1)
      await expect(page.getByTestId('autonomy-summary')).toContainText('Autonomous project, as enrolled')

      // The lists on the screen are the lists of the profile: what is allowed, what is withheld.
      const overview = await invoke(page, 'autonomy.overview', { projectId })
      expect(overview.enrollment?.profile).toBe('AUTONOMOUS_PROJECT')
      if (!overview.summary) throw new Error('No summary')
      expect(overview.summary.allowed.length).toBeGreaterThan(0)
      expect(overview.summary.withheld.length).toBeGreaterThan(0)
      await expect(page.getByTestId('autonomy-allowed').locator('li')).toHaveText(overview.summary.allowed)
      await expect(page.getByTestId('autonomy-withheld').locator('li')).toHaveText(overview.summary.withheld)
      await expect(page.getByTestId('autonomy-never')).toContainText('A profile is a set of permissions NEXUS checks; it is not a sandbox.')
      await screenshot(page, 'v8-autonomy-enrolled')

      // The project page shows the profile.
      await page.getByTestId('nav-projects').click()
      await expect(page.getByTestId('project-autonomy-line')).toContainText('Autonomous project profile')

      // Narrowing needs no confirmation.
      await openAutonomySettings(page)
      await expect(page.getByTestId('autonomy-change')).toBeDisabled()
      await page.getByTestId('autonomy-profile-LOCKED_DOWN').check()
      await expect(page.getByTestId('autonomy-summary')).toContainText('If you choose Locked down')
      await page.getByTestId('autonomy-change').click()
      await expect(page.getByTestId('autonomy-state')).toContainText('Enrolled: Locked down')
      expect(await confirmationCount(app)).toBe(1)
      expect((await invoke(page, 'autonomy.overview', { projectId })).enrollment?.profile).toBe('LOCKED_DOWN')

      // Widening again asks.
      await page.getByTestId('autonomy-profile-BALANCED').check()
      await page.getByTestId('autonomy-change').click()
      await expect(page.getByTestId('autonomy-state')).toContainText('Enrolled: Balanced')
      expect(await confirmationCount(app)).toBe(2)

      // Stopping autonomous work is confirmed in the window and returns the project to approvals.
      await page.getByTestId('autonomy-stop').click()
      await page.getByTestId('confirm-dialog-confirm').click()
      await expect(page.getByTestId('autonomy-state')).toContainText('Not enrolled')
      await expect(page.getByTestId('autonomy-state')).toContainText('NEXUS asks before sensitive actions in this project')
      await expect(page.getByTestId('autonomy-enable')).toBeVisible()
      expect((await invoke(page, 'autonomy.overview', { projectId })).enrollment).toBeNull()
      await page.getByTestId('nav-projects').click()
      await expect(page.getByTestId('project-autonomy-line')).toContainText('Not enrolled')
    } finally {
      await closeApp(app)
    }
  })

  test('the isolation panel states what is in effect, and the project page panels start empty and refresh', async () => {
    test.setTimeout(180_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      const projectId = await openProject(page)

      // The project page: no application and no research yet, each with its sentence, and Refresh works.
      const apps = page.getByTestId('app-sessions-panel')
      await expect(apps).toContainText('No application launched')
      await expect(apps).toContainText('No application has been launched for this project in this session of NEXUS.')
      await page.getByTestId('app-sessions-refresh').click()
      await expect(page.getByTestId('app-sessions-refresh')).toBeEnabled()
      await expect(apps).toContainText('No application launched')
      const research = page.getByTestId('research-panel')
      await expect(research).toContainText('Nothing read')
      await expect(research).toContainText('NEXUS has read nothing from the public web for this project.')
      await expect(research).toContainText('No file has been downloaded for this project.')
      await page.getByTestId('research-refresh').click()
      await expect(page.getByTestId('research-refresh')).toBeEnabled()
      await expect(research).toContainText('Nothing read')
      expect(await invoke(page, 'research.list', { projectId })).toEqual({ artifacts: [], downloads: [] })
      expect(await invoke(page, 'isolation.apps', { projectId })).toEqual([])

      // Settings, Autonomy: the panel reports the effective profile and whether it held, whichever this machine has.
      await openAutonomySettings(page)
      const status = await invoke(page, 'isolation.status', {})
      const panel = page.getByTestId('isolation-panel')
      await expect(panel).toBeVisible()
      const effective = { ISOLATED: 'Isolated', RESTRICTED: 'Restricted', STANDARD: 'Standard' }[status.effective]
      await expect(page.getByTestId('isolation-effective')).toContainText(`${effective}, ${status.usable ? 'verified' : 'not verified'}`)
      await expect(page.getByTestId('isolation-isolated')).toBeVisible()
      await expect(page.getByTestId('isolation-restricted')).toBeVisible()
      await expect(page.getByTestId('isolation-standard')).toBeVisible()
      await expect(page.getByTestId('isolation-protected-block')).toContainText('Protected from contained code')

      // The setup button is offered exactly when the sandbox account is missing and this build can set it up.
      // It is never clicked here: it would raise an elevation prompt.
      const button = page.getByTestId('isolation-setup-button')
      if (!status.sandboxAccount && status.setupAvailable) {
        await expect(button).toBeVisible()
        await expect(button).toBeEnabled()
      } else {
        await expect(button).toHaveCount(0)
        await expect(page.getByTestId('isolation-setup')).toContainText(status.sandboxAccount ? 'The sandbox account is set up for this user.' : 'not available in this build')
      }
      await screenshot(page, 'v8-isolation-panel')
    } finally {
      await closeApp(app)
    }
  })

  test('one out-of-boundary action tried again and again is one request in the inbox; Deny resolves it', async () => {
    test.setTimeout(300_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      const projectId = await openProject(page)
      const { requestId } = await startBoundaryMission(page, projectId)

      // Three attempts, one request, counted; one entry in the status bar and none in the approvals.
      const pending = await invoke(page, 'autonomy.pending', {})
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({ id: requestId, capability: 'GIT_PUSH', state: 'PENDING' })
      expect(pending[0]?.occurrences).toBeGreaterThanOrEqual(3)
      await expect(page.getByTestId('boundary-badge')).toContainText('1 boundary decision')
      await expect(page.getByTestId('approval-count')).toHaveText('0')

      // The inbox shows capability, resource, the action as text and every decision the request allows.
      await page.getByTestId('boundary-badge').click()
      await expect(page.getByTestId('boundary-drawer')).toBeVisible()
      const cards = page.getByTestId('boundary-request')
      await expect(cards).toHaveCount(1)
      await expect(cards).toContainText('Push to a Git remote')
      await expect(cards).toContainText('Resource:')
      await expect(cards).toContainText('Waiting for you')
      await expect(cards).toContainText(/Met \d+ times/)
      await expect(page.getByTestId('boundary-action')).toContainText('git push origin main')
      for (const id of ['boundary-allow-once', 'boundary-allow-mission', 'boundary-allow-project', 'boundary-deny']) {
        await expect(cards.getByTestId(id)).toBeVisible()
      }
      await screenshot(page, 'v8-boundary-inbox')

      // Deny: the request leaves the pending list and appears as decided; the status bar entry goes.
      await cards.getByTestId('boundary-deny').click()
      await expect(cards).toHaveCount(0)
      await expect(page.getByTestId('boundary-empty')).toBeVisible()
      await expect(page.getByTestId('boundary-recent')).toHaveCount(1)
      await expect(page.getByTestId('boundary-recent')).toContainText('Push to a Git remote')
      await expect(page.getByTestId('boundary-recent')).toContainText('Denied')
      await expect(page.getByTestId('boundary-badge')).toHaveCount(0)
      expect(await invoke(page, 'autonomy.pending', {})).toEqual([])
      expect((await invoke(page, 'autonomy.recent', {})).find((r) => r.id === requestId)?.state).toBe('DENIED')
      // A denial is not a grant.
      expect((await invoke(page, 'autonomy.overview', { projectId })).grants).toEqual([])
    } finally {
      await closeApp(app)
    }
  })

  test('Allow for this mission creates a grant that is listed and can be taken back', async () => {
    test.setTimeout(300_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      const projectId = await openProject(page)
      const { requestId } = await startBoundaryMission(page, projectId)

      await page.getByTestId('boundary-badge').click()
      await page.getByTestId('boundary-request').getByTestId('boundary-allow-mission').click()
      await expect(page.getByTestId('boundary-request')).toHaveCount(0)
      await expect(page.getByTestId('boundary-recent')).toContainText('Allowed for this mission')
      await expect(page.getByTestId('boundary-badge')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('boundary-drawer')).toBeHidden()

      // The grant is listed in the project's settings while the mission runs, and taking it back is one click.
      await openAutonomySettings(page)
      const rows = page.locator('[data-testid^="autonomy-grant-"]')
      await expect(rows).toHaveCount(1)
      await expect(rows).toContainText('Push to a Git remote')
      await expect(rows).toContainText('This mission')
      await expect(rows).toContainText('Active')
      const granted = (await invoke(page, 'autonomy.overview', { projectId })).grants
      expect(granted).toHaveLength(1)
      expect(granted[0]).toMatchObject({ capability: 'GIT_PUSH', scope: 'MISSION', active: true, requestId })
      await page.getByTestId('autonomy-take-back').click()
      await expect(rows).toContainText('Taken back')
      await expect(page.getByTestId('autonomy-take-back')).toHaveCount(0)
      const after = (await invoke(page, 'autonomy.overview', { projectId })).grants
      expect(after[0]?.active).toBe(false)
      expect(after[0]?.revokedAt).not.toBeNull()
    } finally {
      await closeApp(app)
    }
  })

  test('the inbox is opened and a request is answered with the keyboard alone', async () => {
    test.setTimeout(300_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      const projectId = await openProject(page)
      const { requestId } = await startBoundaryMission(page, projectId)

      // The entry in the status bar is a button: focus it and press Enter.
      const badge = page.getByTestId('boundary-badge')
      await expect(badge).toBeVisible()
      await badge.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('boundary-drawer')).toBeVisible()
      await expect(page.getByTestId('boundary-request')).toHaveCount(1)

      // Tab stays inside the drawer and reaches the answers in order; Enter answers.
      await tabTo(page, 'boundary-allow-once')
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true)
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('boundary-request')).toHaveCount(0)
      await expect(page.getByTestId('boundary-recent')).toContainText('Allowed once')
      expect((await invoke(page, 'autonomy.recent', {})).find((r) => r.id === requestId)?.state).toBe('GRANTED')

      // Escape closes the drawer.
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('boundary-drawer')).toBeHidden()
    } finally {
      await closeApp(app)
    }
  })
})
