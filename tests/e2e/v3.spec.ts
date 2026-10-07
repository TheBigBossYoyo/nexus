import { selectExactCompilation } from './helpers'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { closeApp, createRepo, invoke, launchApp, removeDir, screenshot, tempDir } from './helpers'

/**
 * NEXUS 0.3 against the built app with the scripted runtime: the redesigned shell and pages, the usage
 * states, the quota banner with automatic resume, an Arena campaign and the policy page. No real Claude
 * session runs here.
 *
 * Screens that are the same on every run (first launch, empty and default states) are compared against
 * stored images. Screens that show times, ids or progress are captured to `test-results/screenshots`
 * for review and are not compared pixel by pixel.
 */

const SIZE = { width: 1440, height: 900 }

async function fixWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setContentSize(size.width, size.height)
  }, SIZE)
}

/** Stored-image comparison of a stable screen. The version label and anything marked as a time are masked. */
async function expectScreen(page: Page, name: string): Promise<void> {
  // The pointer rests on empty content so no hover state is part of the picture.
  await page.mouse.move(SIZE.width - 300, SIZE.height - 40)
  await expect(page).toHaveScreenshot(`${name}.png`, {
    mask: [page.getByTestId('app-version'), page.locator('time'), page.locator('[data-volatile]')],
    animations: 'disabled',
    caret: 'hide',
  })
}

async function openProject(page: Page): Promise<string> {
  await page.getByTestId('nav-projects').click()
  await page.getByTestId('open-project').click()
  await expect(page.getByTestId('project-detail')).toBeVisible()
  const project = (await invoke(page, 'projects.list', {}))[0]
  if (!project) throw new Error('The project was not opened')
  return project.id
}

async function startMission(page: Page, prompt: string, strategy = 'BUILD'): Promise<string> {
  await page.getByTestId('mission-prompt').fill(prompt)
  await page.getByTestId('mode-select').selectOption('build')
  await page.getByTestId('strategy-select').selectOption(strategy)
  await page.getByTestId('plan-approval-toggle').uncheck()
  await selectExactCompilation(page)
  await page.getByTestId('create-run').click()
  await expect(page.getByTestId('run-view')).toBeVisible()
  const runs = await invoke(page, 'runs.list', {})
  const run = runs[0]
  if (!run) throw new Error('No run was created')
  return run.id
}

const runState = async (page: Page, runId: string): Promise<string> => (await invoke(page, 'runs.get', { runId })).run.state

test.describe('NEXUS 0.3 UI', () => {
  const dirs: string[] = []
  test.afterAll(() => {
    for (const d of dirs) removeDir(d)
  })

  test('shell, navigation and the pages of a first launch', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    // The scripted runtime reports no usage figures here: what a runtime without a usage report looks like.
    const { app, page } = await launchApp(dataDir, repo, { NEXUS_FAKE_USAGE: 'unknown' })
    try {
      await fixWindow(app)
      // Home is the first screen and is useful with nothing in it yet.
      await expect(page.getByTestId('home-view')).toBeVisible()
      await expect(page.getByTestId('usage-indicator')).toBeVisible()
      await expectScreen(page, 'home-first-launch')

      // Every navigation item opens its page.
      for (const view of ['projects', 'run', 'agents', 'arena', 'policy', 'usage', 'performance', 'intelligence', 'overnight', 'activity', 'memory', 'settings', 'home']) {
        await page.getByTestId(`nav-${view}`).click()
        await expect(page.getByTestId(`view-${view}`)).toBeVisible()
      }

      // The sidebar collapses and comes back (Ctrl+B), and the command palette opens (Ctrl+K).
      await page.keyboard.press('Control+b')
      await expectScreen(page, 'home-collapsed-nav')
      await page.keyboard.press('Control+b')
      await page.keyboard.press('Control+k')
      await expect(page.getByTestId('command-palette')).toBeVisible()
      await page.keyboard.type('usage')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('usage-view')).toBeVisible()

      // Usage with nothing known: no percentage, no bar, and it reads as intentional rather than broken.
      const subscription = page.getByTestId('usage-subscription')
      await expect(subscription).toContainText('Not exposed by Claude runtime')
      await expect(subscription).not.toContainText('%')
      await expect(subscription.locator('[role="progressbar"]')).toHaveCount(0)
      await expect(page.getByTestId('usage-view')).toContainText('does not expose total subscription capacity')
      await expectScreen(page, 'usage-unknown')

      // The header indicator opens the usage popover, which says the same thing.
      await page.getByTestId('usage-indicator').click()
      const popover = page.getByTestId('usage-popover')
      await expect(popover).toBeVisible()
      await expect(popover).toContainText(/Not exposed by (the )?(Claude )?runtime/i)
      await expect(popover.locator('[role="progressbar"]')).toHaveCount(0)
      await expectScreen(page, 'usage-popover-unknown')
      await page.keyboard.press('Escape')

      // Empty and default states of the other new pages.
      await page.getByTestId('nav-arena').click()
      await expect(page.getByTestId('arena-empty')).toContainText('No Arena campaigns yet')
      await expectScreen(page, 'arena-empty')
      await page.getByTestId('arena-new-campaign').click()
      await expect(page.getByTestId('arena-campaign-dialog')).toBeVisible()
      await expect(page.getByTestId('arena-case-list')).toContainText('Pagination drops one-item last pages')
      await expectScreen(page, 'arena-new-campaign')
      await page.keyboard.press('Escape')

      await page.getByTestId('nav-policy').click()
      await expect(page.getByTestId('policy-version')).toContainText('1')
      await expect(page.getByTestId('policy-candidates-empty')).toBeVisible()
      await expectScreen(page, 'policy-default')

      await page.getByTestId('nav-overnight').click()
      await expect(page.getByTestId('overnight-view')).toBeVisible()
      await expectScreen(page, 'overnight-empty')

      await page.getByTestId('nav-activity').click()
      await expect(page.getByTestId('activity-view')).toBeVisible()
      await expectScreen(page, 'activity-empty')

      await page.getByTestId('nav-settings').click()
      await page.getByTestId('settings-section-usage').click()
      await expect(page.getByTestId('view-settings')).toContainText('Auto resume')
      await expectScreen(page, 'settings-usage')
      await page.getByTestId('settings-section-appearance').click()
      await expect(page.getByTestId('theme-select')).toHaveValue('light')
      await expectScreen(page, 'settings-appearance')

      // The renderer still has no way to the system except the bridge.
      expect(await page.evaluate(() => Object.keys((globalThis as unknown as { nexus: object }).nexus).sort())).toEqual(['invoke', 'onPush'])
    } finally {
      await closeApp(app)
    }
  })

  test('usage with figures the runtime reported: an exact percentage with its source, never a guess', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo, { NEXUS_FAKE_USAGE: '42' })
    try {
      await fixWindow(app)
      await page.getByTestId('nav-usage').click()
      await page.getByTestId('usage-refresh').click()
      const windows = page.getByTestId('usage-windows')
      await expect(windows).toContainText('42')
      await expect(page.getByTestId('usage-status')).toContainText(/Exact/i)
      const overview = await invoke(page, 'usage.overview', {})
      expect(overview.subscriptionUtilizationPercent).toMatchObject({ value: 42, confidence: 'EXACT' })
      // Observed figures carry no denominator anywhere in the read model.
      expect(overview.session).not.toHaveProperty('limit')
      await screenshot(page, 'v3-usage-exact')
    } finally {
      await closeApp(app)
    }
  })

  test('a usage limit with a known reset: banner, countdown, automatic resume, mission completes', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo, {
      NEXUS_USAGE_TICK_MS: '300',
      NEXUS_USAGE_RESUME_DELAY_S: '2',
      NEXUS_USAGE_DEMO_RESET_S: '8',
    })
    try {
      await fixWindow(app)
      await openProject(page)
      const runId = await startMission(page, 'Add an API module and a UI module, then integrate them. [demo:quota-reset]')

      // The limit pauses the run without failing anything.
      const banner = page.getByTestId('quota-banner')
      await expect(banner).toBeVisible({ timeout: 60_000 })
      await expect(banner).toContainText(/usage limit/i)
      await expect(banner).toContainText(/No work has been lost/i)
      // The reset time is the one the runtime gave, shown as a clock time, with the planned resume after it.
      await expect(page.getByTestId('quota-reset')).toHaveText(/\d{1,2}:\d{2}/)
      await expect(page.getByTestId('quota-resume-at')).toHaveText(/\d{1,2}:\d{2}/)
      await expect(page.getByTestId('usage-indicator')).toContainText(/Reset|Paused|Waiting|Checking/i)
      const paused = await invoke(page, 'runs.get', { runId })
      expect(paused.run).toMatchObject({ state: 'paused', pauseReason: 'quota' })
      expect(paused.tasks.filter((t) => t.state === 'failed')).toEqual([])
      const waiting = await invoke(page, 'usage.overview', {})
      expect(waiting.autoResume.pause).not.toBeNull()
      expect(waiting.nextResetAt).toMatchObject({ confidence: 'EXACT' })
      await screenshot(page, 'v3-quota-paused-exact-reset')
      // Mission Control shows the same calm state, not an error.
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'paused')
      await screenshot(page, 'v3-mission-quota-paused')

      // Capacity returns: NEXUS resumes by itself and the mission finishes.
      await expect(banner).toBeHidden({ timeout: 60_000 })
      await expect.poll(() => runState(page, runId), { timeout: 150_000, intervals: [500] }).toBe('completed')
      const done = await invoke(page, 'runs.get', { runId })
      expect(done.tasks.filter((t) => t.parentTaskId === null).every((t) => t.state === 'completed')).toBe(true)
      const events = await invoke(page, 'events.list', { runId, limit: 5000 })
      const types = events.map((e) => e.type)
      expect(types).toContain('usage.quota_paused')
      expect(types).toContain('usage.quota_resumed')
      // One pause, resumed after an availability check, recorded in the limit history.
      const history = await invoke(page, 'usage.limitHistory', {})
      const pause = history.pauses.find((p) => p.runId === runId)
      expect(pause).toMatchObject({ state: 'resumed' })
      // The availability check belongs to the wait as a whole (the global row); the resume to the run.
      const attempts = history.pauses.flatMap((p) => p.resumes)
      expect(attempts.some((r) => r.kind === 'probe' && r.result === 'available')).toBe(true)
      expect(attempts.filter((r) => r.kind === 'resume' && r.result === 'resumed' && r.runId === runId)).toHaveLength(1)

      await page.getByTestId('nav-usage').click()
      await expect(page.getByTestId('usage-limits')).toContainText(/resumed/i)
      await expect(page.getByTestId('usage-header-status')).toContainText('Available')
      await screenshot(page, 'v3-usage-after-resume')
    } finally {
      await closeApp(app)
    }
  })

  test('a usage limit with no reset time: says so, probes conservatively, resumes when Claude is available', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo, {
      NEXUS_USAGE_TICK_MS: '300',
      NEXUS_USAGE_PROBE_S: '2',
    })
    try {
      await fixWindow(app)
      await openProject(page)
      const runId = await startMission(page, 'Add an API module and a UI module, then integrate them. [demo:quota-unknown]')

      const banner = page.getByTestId('quota-banner')
      await expect(banner).toBeVisible({ timeout: 60_000 })
      await expect(banner).toContainText(/gave no reset time/i)
      const waiting = await invoke(page, 'usage.overview', {})
      // Nothing is invented: the reset is unknown, and the planned check is labelled an estimate.
      expect(waiting.nextResetAt).toMatchObject({ value: null, confidence: 'UNKNOWN' })
      expect(waiting.autoResume.nextCheckAt.confidence).not.toBe('EXACT')
      expect(waiting.subscriptionUtilizationPercent.confidence === 'EXACT' || waiting.subscriptionUtilizationPercent.value === null).toBe(true)
      await screenshot(page, 'v3-quota-paused-unknown-reset')

      await expect.poll(() => runState(page, runId), { timeout: 150_000, intervals: [500] }).toBe('completed')
      const history = await invoke(page, 'usage.limitHistory', {})
      const pause = history.pauses.find((p) => p.runId === runId)
      expect(pause).toMatchObject({ state: 'resumed', resetAt: null })
      // The first check still found the limit; a later one succeeded. Never more than one check per interval.
      const probes = history.pauses.flatMap((p) => p.resumes).filter((r) => r.kind === 'probe')
      expect(probes.map((r) => r.result)).toEqual(['still_limited', 'available'])
      await expect(banner).toBeHidden()
    } finally {
      await closeApp(app)
    }
  })

  test('mission control, inspector and agents after a SINGLE mission; why-this-strategy for ADAPTIVE', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await fixWindow(app)
      await openProject(page)

      // The composer explains what ADAPTIVE would do before the mission starts.
      await page.getByTestId('mission-prompt').fill('Fix the off-by-one error in the pagination helper.')
      await page.getByTestId('strategy-select').selectOption('ADAPTIVE')
      await expect(page.getByTestId('strategy-preview')).toContainText(/Adaptive would choose|Adaptive picks/i)
      await screenshot(page, 'v3-composer-adaptive')

      const runId = await startMission(page, 'Fix the off-by-one error in the pagination helper.', 'ADAPTIVE')
      const created = await invoke(page, 'runs.get', { runId })
      expect(created.run.config.strategy).toMatchObject({ requested: 'ADAPTIVE' })
      const info = await invoke(page, 'policy.run', { runId })
      expect(info.decision?.reason.length).toBeGreaterThan(10)
      expect(info.profile?.contextKey).toMatch(/^[a-z]+\|[a-z]+\|[a-z]+$/)
      await expect.poll(() => runState(page, runId), { timeout: 150_000, intervals: [500] }).toMatch(/completed|paused/)
      await expect(page.getByTestId('run-view')).toBeVisible()
      await screenshot(page, 'v3-mission-control')

      // The outcome of the mission was recorded for the policy, and observed usage for the run.
      const after = await invoke(page, 'policy.run', { runId })
      expect(after.outcome).toMatchObject({ requestedStrategy: 'ADAPTIVE', isArena: false })
      const usage = await invoke(page, 'usage.run', { runId })
      expect(usage.totals.sessions).toBeGreaterThan(0)
      expect(usage.totals.inputTokens).toBeGreaterThan(0)

      // Inspector and agents open on the redesigned screens.
      await page.getByTestId('stage-tab-graph').click()
      const node = page.locator('[data-testid^="task-node-"]').first()
      await node.click()
      await expect(page.getByTestId('task-inspector')).toBeVisible()
      await screenshot(page, 'v3-task-inspector')
      await page.getByTestId('nav-agents').click()
      await expect(page.getByTestId('agents-view')).toBeVisible()
      await screenshot(page, 'v3-agents')
      await page.getByTestId('nav-home').click()
      await expect(page.getByTestId('home-view')).toContainText(/mission/i)
      await screenshot(page, 'v3-home-with-data')
      await page.getByTestId('nav-policy').click()
      await expect(page.getByTestId('policy-decisions')).toContainText(/default|evidence|exploration/i)
      await screenshot(page, 'v3-policy-with-decision')
    } finally {
      await closeApp(app)
    }
  })

  test('an Arena campaign: created in the dialog, trials isolated and evaluated, results and policy evidence', async () => {
    test.setTimeout(300_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await fixWindow(app)
      await page.getByTestId('nav-arena').click()
      await page.getByTestId('arena-new-campaign').click()
      const dialog = page.getByTestId('arena-campaign-dialog')
      await dialog.getByTestId('arena-campaign-name').fill('E2E campaign')
      await dialog.getByTestId('arena-case-bugfix-localized').click()
      for (const strategy of ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS', 'SPECULATIVE']) {
        const box = dialog.getByTestId(`arena-strategy-${strategy}`)
        if (strategy === 'SINGLE' || strategy === 'BUILD') await box.check()
        else await box.uncheck()
      }
      await dialog.getByTestId('arena-repetitions').fill('1')
      await expect(dialog.getByTestId('arena-trial-summary')).toContainText('2 trials')
      await dialog.getByTestId('arena-create-start').click()
      await expect.poll(async () => (await invoke(page, 'arena.campaigns', {})).total, { timeout: 30_000 }).toBe(1)
      await expect(dialog).toBeHidden()
      await screenshot(page, 'v3-arena-after-create')

      // The campaign page opens by itself; it runs both strategies on the same case, one trial each.
      await expect(page.getByTestId('arena-campaign')).toBeVisible()
      await expect(page.getByTestId('arena-matrix')).toBeVisible()
      const campaigns = await invoke(page, 'arena.campaigns', {})
      const campaignId = campaigns.campaigns[0]!.campaign.id
      await expect
        .poll(async () => (await invoke(page, 'arena.campaign', { campaignId })).campaign.state, { timeout: 240_000, intervals: [1000] })
        .toBe('completed')
      await screenshot(page, 'v3-arena-matrix')

      const detail = await invoke(page, 'arena.campaign', { campaignId })
      const { trials } = await invoke(page, 'arena.trials', { campaignId })
      expect(trials.map((t) => t.trial.strategy).sort()).toEqual(['BUILD', 'SINGLE'])
      // Same baseline, separate repositories; the scripted agents do not fix the bug, so the hidden evaluator
      // fails both trials, and a failed trial scores 0 whatever it cost.
      expect(new Set(trials.map((t) => t.trial.baselineCommit)).size).toBe(1)
      expect(new Set(trials.map((t) => t.trial.repoPath)).size).toBe(2)
      for (const t of trials) {
        expect(t.trial.state).toBe('failed')
        expect(t.hiddenPassed).toBe(false)
        expect(t.score).toBe(0)
        expect(t.metrics?.sessions).toBeGreaterThan(0)
      }
      expect(detail.comparison.every((row) => row.passed === 0 && row.label === 'INSUFFICIENT')).toBe(true)
      // Trial projects never appear among the user's projects or missions.
      expect(await invoke(page, 'projects.list', {})).toEqual([])
      expect((await invoke(page, 'home.summary', {})).recentRuns).toEqual([])

      // Each matrix cell says Fail in words, not only in colour.
      for (const strategy of ['SINGLE', 'BUILD']) {
        await expect(page.getByTestId(`arena-cell-bugfix-localized-${strategy}`)).toContainText(/fail/i)
      }
      await page.getByTestId('arena-tab-results').click()
      await expect(page.getByTestId('arena-results')).toBeVisible()
      await expect(page.getByTestId('arena-notes')).toBeVisible()
      await screenshot(page, 'v3-arena-results')
      await page.getByTestId('arena-tab-trials').click()
      await page.locator('[data-testid^="arena-trial-row-"]').first().click()
      await expect(page.getByTestId('arena-evaluation')).toContainText(/failed/i)
      await expect(page.getByTestId('arena-metrics')).toBeVisible()
      await screenshot(page, 'v3-arena-trial')
      await page.keyboard.press('Escape')

      // The finished campaign refreshed the policy's evidence and changed no policy.
      await page.getByTestId('nav-policy').click()
      const overview = await invoke(page, 'policy.overview', {})
      expect(overview.evidence.arenaTrials).toBe(2)
      expect(overview.active.version).toBe(1)
      expect(overview.candidates).toEqual([])
      await page.getByTestId('policy-learn').click()
      await expect(page.getByTestId('policy-learn-result')).toBeVisible()
      await screenshot(page, 'v3-policy-after-campaign')
    } finally {
      await closeApp(app)
    }
  })
})
