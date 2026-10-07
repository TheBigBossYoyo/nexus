import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT, type OvernightPolicy, type OvernightStatus } from '../../src/shared/overnight'
import { closeApp, createRepo, git, invoke, launchApp, removeDir, screenshot, tempDir, selectExactCompilation } from './helpers'

/**
 * Overnight Mode against the built app. The power controller is the fake one (it is selected whenever
 * the scripted runtime is, and cannot be selected in a packaged build): nothing here can shut down,
 * sleep or hibernate the machine. The fake appends every call to `fake-power.log` in the data directory.
 */
interface PowerCall {
  operation: 'scheduleShutdown' | 'cancelShutdown' | 'sleep' | 'hibernate'
  args: string[]
  request: { delaySeconds: number; force: boolean; purpose: string } | null
  ok: boolean
}

function powerLog(dataDir: string): PowerCall[] {
  const path = join(dataDir, 'fake-power.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as PowerCall)
}

const summary = (calls: PowerCall[]): string[] => calls.map((c) => `${c.operation}${c.request ? `:${c.request.purpose}` : ''}${c.ok ? '' : ':refused'}`)

async function openProject(page: Page): Promise<string> {
  await page.getByTestId('nav-projects').click()
  await page.getByTestId('open-project').click()
  await expect(page.getByTestId('project-detail')).toBeVisible()
  const project = (await invoke(page, 'projects.list', {}))[0]
  if (!project) throw new Error('The project was not opened')
  return project.id
}

/** Start an overnight run through the same IPC channel the composer uses. */
async function startOvernight(page: Page, projectId: string, prompt: string, policy: Partial<OvernightPolicy> = {}): Promise<string> {
  const { run } = await invoke(page, 'overnight.start', {
    projectId,
    preset: 'balanced',
    prompt,
    compilationMode: 'EXACT',
    policy: { ...DEFAULT_OVERNIGHT_POLICY, ...policy },
    confirmed: true,
    confirmation: OVERNIGHT_CONFIRMATION_TEXT,
    planningMode: 'single',
  })
  return run.id
}

async function waitForOvernight(page: Page, runId: string, states: OvernightStatus['state'][], timeout = 120_000): Promise<OvernightStatus> {
  let last: OvernightStatus | null = null
  await expect
    .poll(
      async () => {
        last = await invoke(page, 'overnight.get', { runId })
        return last?.state
      },
      { timeout, intervals: [500] },
    )
    .toMatch(new RegExp(`^(${states.join('|')})$`))
  if (!last) throw new Error('No overnight record')
  return last
}

const trayModel = (app: ElectronApplication): Promise<{ visible: boolean; status: string | null; tooltip: string; items: { action: string; enabled: boolean }[] } | null> =>
  app.evaluate(() => (globalThis as unknown as { __nexusTrayModel: () => never }).__nexusTrayModel())

test.describe('Overnight Mode', () => {
  const dirs: string[] = []
  test.afterAll(() => {
    for (const d of dirs) removeDir(d)
  })

  test('composer: explicit authorization, confirmation, failsafe armed, success, report, final shutdown scheduled, cancel', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await openProject(page)
      await page.getByTestId('mission-prompt').fill('Add an API module and a UI module, then integrate them.')
      await page.getByTestId('mode-select').selectOption('overnight')
      await selectExactCompilation(page)
      await expect(page.getByTestId('overnight-panel')).toBeVisible()
      await screenshot(page, 'overnight-1-composer')

      // Nothing starts without the run-specific authorization, and force close is off by default.
      await expect(page.getByTestId('overnight-start')).toBeDisabled()
      await expect(page.getByTestId('overnight-authorize')).not.toBeChecked()
      await expect(page.getByTestId('overnight-force-close')).not.toBeChecked()
      await expect(page.getByTestId('overnight-end-action')).toHaveValue('SHUTDOWN')
      await page.getByTestId('overnight-force-close').check()
      await page.getByTestId('overnight-authorize').check()
      await expect(page.getByTestId('overnight-start')).toBeEnabled()
      expect(powerLog(dataDir)).toEqual([])

      await page.getByTestId('overnight-start').click()
      const dialog = page.getByTestId('overnight-confirm-dialog')
      await expect(dialog).toBeVisible()
      await expect(page.getByTestId('overnight-confirm-summary')).toContainText('This run is authorized to shut down Windows automatically.')
      await screenshot(page, 'overnight-2-confirmation')
      // Still nothing scheduled: the confirmation is the last step.
      expect(powerLog(dataDir)).toEqual([])
      expect(await invoke(page, 'runs.list', {})).toHaveLength(0)
      await page.getByTestId('overnight-confirm-start').click()

      // The banner is there for the whole run.
      await expect(page.getByTestId('run-view')).toBeVisible()
      const banner = page.getByTestId('overnight-banner')
      await expect(banner).toBeVisible()
      await expect(page.getByTestId('overnight-failsafe')).toContainText(/\d{1,2}:\d{2}/)
      await expect(page.getByTestId('overnight-deadline')).toContainText(/\d{1,2}:\d{2}/)
      await expect(page.getByTestId('overnight-end-action-label')).toContainText(/shut down/i)
      await expect(page.getByTestId('overnight-indicator')).toBeVisible()
      await screenshot(page, 'overnight-3-banner')

      const runId = (await invoke(page, 'runs.list', {}))[0]?.id ?? ''
      const started = await invoke(page, 'overnight.get', { runId })
      expect(started?.authorization).toMatchObject({ runId, confirmation: OVERNIGHT_CONFIRMATION_TEXT })
      expect(started?.policy.forceCloseApplications).toBe(true)
      expect(started?.failsafe?.result.ok).toBe(true)
      // The failsafe was the first thing that happened: 9 hours, armed before any agent session.
      const first = powerLog(dataDir)[0]
      expect(first).toMatchObject({ operation: 'scheduleShutdown', ok: true, request: { purpose: 'failsafe', delaySeconds: 32_400, force: true } })
      expect(first?.args.slice(0, 4)).toEqual(['/s', '/f', '/t', '32400'])
      // The first agent session may not have started yet when the dialog closes: wait for it, then compare.
      await expect.poll(async () => (await invoke(page, 'events.list', { runId, limit: 5000 })).some((e) => e.type === 'agent.started'), { timeout: 60_000, message: 'the first agent session to start' }).toBe(true)
      const events = await invoke(page, 'events.list', { runId, limit: 5000 })
      const armedSeq = events.find((e) => e.type === 'overnight.failsafe')?.seq ?? Infinity
      const firstAgentSeq = events.find((e) => e.type === 'agent.started')?.seq ?? -1
      expect(firstAgentSeq).toBeGreaterThan(0)
      expect(armedSeq).toBeLessThan(firstAgentSeq)
      expect((await trayModel(app))?.status).toBe('RUNNING')

      // No plan approval is asked for: the run goes straight through to completion.
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'completed', { timeout: 150_000 })
      const scheduled = await waitForOvernight(page, runId, ['POWER_ACTION_SCHEDULED'])
      expect(scheduled.terminalReason).toBe('SUCCESS')
      expect(scheduled.powerAction).toMatchObject({ action: 'SHUTDOWN', mechanism: 'os_timer', forced: true })
      expect(scheduled.failsafe?.cancelledAt).not.toBeNull()
      expect(summary(powerLog(dataDir))).toEqual(['scheduleShutdown:failsafe', 'cancelShutdown', 'scheduleShutdown:final'])
      expect(powerLog(dataDir)[2]?.args.slice(0, 4)).toEqual(['/s', '/f', '/t', '60'])

      // The report was saved before the final shutdown was scheduled.
      const report = await invoke(page, 'overnight.report', { runId })
      expect(report.text).toContain('# NEXUS Overnight Run')
      expect(report.text).toContain('**SUCCESS**')
      expect(existsSync(report.path ?? '')).toBe(true)
      expect(Date.parse(scheduled.reportSavedAt ?? '')).toBeLessThanOrEqual(Date.parse(scheduled.powerAction?.scheduledAt ?? ''))
      const audit = await invoke(page, 'overnight.audit', { runId })
      expect(audit.map((a) => a.operation)).toEqual(['arm_failsafe', 'cancel_failsafe', 'schedule_final'])
      expect((await invoke(page, 'overnight.checkpoints', { runId })).length).toBeGreaterThan(2)

      await expect(page.getByTestId('overnight-state')).toHaveText('POWER_ACTION_SCHEDULED')
      await expect(page.getByTestId('overnight-countdown')).toBeVisible()
      expect((await trayModel(app))?.status).toBe('SHUTDOWN SCHEDULED')
      await screenshot(page, 'overnight-4-countdown')
      await page.getByTestId('overnight-report-open').click()
      await expect(page.getByTestId('overnight-report-dialog')).toContainText('NEXUS Overnight Run')
      await page.keyboard.press('Escape')

      // The user is back and cancels: the Windows timer is aborted.
      await page.getByTestId('overnight-cancel-shutdown').click()
      const done = await waitForOvernight(page, runId, ['DONE'])
      expect(done.powerAction?.cancelledAt).not.toBeNull()
      expect(summary(powerLog(dataDir)).at(-1)).toBe('cancelShutdown')
      await expect(page.getByTestId('overnight-state')).toHaveText('DONE')
      await expect.poll(async () => (await trayModel(app))?.visible ?? false).toBe(false)

      // The user's checkout is untouched; the report sits in .nexus, which git does not see.
      expect(git(repo, 'status', '--porcelain')).toBe('')
      expect(git(repo, 'branch', '--show-current')).toBe('main')
    } finally {
      await closeApp(app)
    }
  })

  test('mission failure: report, then the configured shutdown', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      const projectId = await openProject(page)
      const runId = await startOvernight(page, projectId, 'This plan cannot be made. [demo:fail]', { forceCloseApplications: true })
      const scheduled = await waitForOvernight(page, runId, ['POWER_ACTION_SCHEDULED'])
      expect(scheduled.terminalReason).toBe('FAILED')
      expect((await invoke(page, 'runs.get', { runId })).run.state).toBe('failed')
      expect((await invoke(page, 'overnight.report', { runId })).text).toContain('FAILED')
      expect(summary(powerLog(dataDir))).toEqual(['scheduleShutdown:failsafe', 'cancelShutdown', 'scheduleShutdown:final'])
      await page.getByTestId(`sidebar-run-${runId}`).click()
      await expect(page.getByTestId('overnight-state')).toHaveText('POWER_ACTION_SCHEDULED')
    } finally {
      await closeApp(app)
    }
  })

  test('quota exhausted: the run is paused (not failed), reported, and the shutdown is scheduled', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      const projectId = await openProject(page)
      // The policy says to end the run on a usage limit (the default, WAIT_AND_RETRY, keeps probing until the deadline).
      const runId = await startOvernight(page, projectId, 'Build the modules. [demo:quota]', { forceCloseApplications: true, quotaPolicy: 'END_RUN' })
      const scheduled = await waitForOvernight(page, runId, ['POWER_ACTION_SCHEDULED'])
      expect(scheduled.terminalReason).toBe('QUOTA_EXHAUSTED')
      const detail = await invoke(page, 'runs.get', { runId })
      expect(detail.run).toMatchObject({ state: 'paused', pauseReason: 'quota' })
      expect(detail.tasks.filter((t) => t.state === 'failed')).toHaveLength(0)
      expect((await invoke(page, 'overnight.report', { runId })).text).toContain('QUOTA_EXHAUSTED')
      expect(summary(powerLog(dataDir)).at(-1)).toBe('scheduleShutdown:final')
    } finally {
      await closeApp(app)
    }
  })

  test('timeout: hiding to the tray keeps the mission alive; the deadline stops it and schedules a normal shutdown', async () => {
    test.setTimeout(240_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      const projectId = await openProject(page)
      const runId = await startOvernight(page, projectId, 'Build the modules. [demo:stall]', { maxDurationMinutes: 1, failsafeAfterMinutes: 3, finalDelaySeconds: 10 })
      await waitForOvernight(page, runId, ['RUNNING'])
      await expect.poll(async () => (await invoke(page, 'runs.get', { runId })).agents.filter((a) => a.role === 'worker').length, { timeout: 60_000 }).toBeGreaterThan(0)

      // Closing the window asks; "Hide to tray and continue" keeps the process and the mission alive.
      await app.evaluate(({ dialog, BrowserWindow }) => {
        const asked: string[] = []
        ;(globalThis as unknown as { __closeDialog: string[] }).__closeDialog = asked
        dialog.showMessageBox = (async (_window: unknown, options: { message: string; buttons: string[] }) => {
          asked.push(options.message, ...options.buttons)
          return { response: 0, checkboxChecked: false }
        }) as never
        BrowserWindow.getAllWindows()[0]?.close()
      })
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? null)).toBe(false)
      const asked = await app.evaluate(() => (globalThis as unknown as { __closeDialog: string[] }).__closeDialog)
      expect(asked).toEqual(['NEXUS is running an overnight mission.', 'Hide to tray and continue', 'Cancel mission', 'Return'])
      const tray = await trayModel(app)
      expect(tray).toMatchObject({ visible: true, status: 'RUNNING' })
      expect(tray?.tooltip).toMatch(/Shutdown scheduled/)
      expect(tray?.items.map((i) => i.action)).toEqual(['open', 'pause', 'cancelPower', 'cancelMission'])
      expect((await invoke(page, 'runs.get', { runId })).run.state).not.toBe('paused')

      // With the window hidden, the main process alone ends the run at the deadline.
      const scheduled = await waitForOvernight(page, runId, ['POWER_ACTION_SCHEDULED', 'DONE'], 120_000)
      expect(scheduled.terminalReason).toBe('TIME_LIMIT')
      expect((await invoke(page, 'runs.get', { runId })).run.state).toBe('paused')
      expect((await invoke(page, 'overnight.report', { runId })).text).toContain('TIMEOUT')
      // A normal (non-forced) shutdown: NEXUS counts down, then replaces the failsafe with `shutdown /s /t 0`.
      const done = await waitForOvernight(page, runId, ['DONE'], 60_000)
      expect(done.powerAction).toMatchObject({ action: 'SHUTDOWN', mechanism: 'app_timer' })
      expect(done.powerAction?.executedAt).not.toBeNull()
      const calls = powerLog(dataDir)
      expect(summary(calls)).toEqual(['scheduleShutdown:failsafe', 'cancelShutdown', 'scheduleShutdown:final'])
      expect(calls[0]?.args).not.toContain('/f')
      expect(calls[2]?.args.slice(0, 3)).toEqual(['/s', '/t', '0'])
      // With the mission over, the window comes back by itself.
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? null), { timeout: 20_000 }).toBe(true)
    } finally {
      await closeApp(app)
    }
  })

  test('restart of NEXUS mid-run: the failsafe stays represented, the run resumes by itself and ends with the shutdown', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)

    const first = await launchApp(dataDir, repo)
    // Quitting NEXUS leaves the Windows failsafe alone.
    const { runId, failsafeDeadline } = await (async () => {
      const projectId = await openProject(first.page)
      const id = await startOvernight(first.page, projectId, 'Build the modules. [demo:stall]', { forceCloseApplications: true })
      await expect.poll(async () => (await invoke(first.page, 'runs.get', { runId: id })).agents.filter((a) => a.role === 'worker').length, { timeout: 60_000 }).toBeGreaterThan(0)
      const deadline = (await invoke(first.page, 'overnight.get', { runId: id }))?.failsafe?.deadline ?? ''
      expect(deadline).not.toBe('')
      return { runId: id, failsafeDeadline: deadline }
    })().finally(() => closeApp(first.app))
    expect(summary(powerLog(dataDir))).toEqual(['scheduleShutdown:failsafe'])

    const second = await launchApp(dataDir, repo)
    try {
      // The record survived; the failsafe is shown as armed with the same deadline and was not scheduled again.
      const recovered = await invoke(second.page, 'overnight.get', { runId })
      expect(recovered?.failsafe).toMatchObject({ deadline: failsafeDeadline, cancelledAt: null, lostAt: null })
      expect(['RUNNING', 'FINALIZING', 'POWER_ACTION_SCHEDULED']).toContain(recovered?.state)
      await second.page.getByTestId(`sidebar-run-${runId}`).click()
      await expect(second.page.getByTestId('overnight-banner')).toBeVisible()
      const events = await invoke(second.page, 'events.list', { runId, limit: 5000 })
      expect(events.some((e) => e.type === 'overnight.state_changed' && (e.payload as { detail?: string }).detail === 'RECOVERING OVERNIGHT RUN')).toBe(true)
      // No recovery dialog decision is needed: the overnight run resumed on its own (the scripted agents now finish).
      await expect(second.page.getByTestId('run-state')).toHaveAttribute('data-state', 'completed', { timeout: 150_000 })
      const scheduled = await waitForOvernight(second.page, runId, ['POWER_ACTION_SCHEDULED'])
      expect(scheduled.terminalReason).toBe('SUCCESS')
      // One failsafe ever; the fresh process aborts it (the simulated OS of the new process has none) and schedules the final shutdown.
      const calls = powerLog(dataDir)
      expect(calls.filter((c) => c.request?.purpose === 'failsafe')).toHaveLength(1)
      expect(summary(calls).at(-1)).toBe('scheduleShutdown:final')
      await second.page.getByTestId('overnight-cancel-shutdown').click()
      await waitForOvernight(second.page, runId, ['DONE'])
    } finally {
      await closeApp(second.app)
    }
  })

  test('Overnight Arena: run overnight from the dialog, failsafe before the first trial, report, final shutdown, cancel', async () => {
    test.setTimeout(360_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await page.getByTestId('nav-arena').click()
      await page.getByTestId('arena-new-campaign').click()
      const dialog = page.getByTestId('arena-campaign-dialog')
      await dialog.getByTestId('arena-campaign-name').fill('Overnight E2E campaign')
      await dialog.getByTestId('arena-case-bugfix-localized').click()
      for (const strategy of ['SINGLE', 'BUILD', 'SWARM', 'CONSENSUS', 'SPECULATIVE']) {
        const box = dialog.getByTestId(`arena-strategy-${strategy}`)
        if (strategy === 'SINGLE') await box.check()
        else await box.uncheck()
      }
      await dialog.getByTestId('arena-repetitions').fill('1')
      await dialog.getByTestId('arena-run-overnight').check()
      await expect(dialog.getByTestId('arena-overnight-form')).toBeVisible()
      // Nothing starts without the campaign-specific authorization.
      await expect(dialog.getByTestId('arena-overnight-start')).toBeDisabled()
      await expect(dialog.getByTestId('arena-overnight-authorize')).not.toBeChecked()
      await dialog.getByTestId('overnight-force-close').check()
      await dialog.getByTestId('arena-overnight-authorize').check()
      await expect(dialog.getByTestId('arena-overnight-start')).toBeEnabled()
      await screenshot(page, 'overnight-arena-1-dialog')
      expect(powerLog(dataDir)).toEqual([])
      expect((await invoke(page, 'arena.campaigns', {})).total).toBe(0)
      await dialog.getByTestId('arena-overnight-start').click()

      await expect(page.getByTestId('arena-overnight-panel')).toBeVisible({ timeout: 30_000 })
      const campaignId = (await invoke(page, 'arena.campaigns', {})).campaigns[0]?.campaign.id ?? ''
      const started = await invoke(page, 'overnight.get', { runId: campaignId })
      expect(started).toMatchObject({ workloadType: 'arena_campaign', runId: campaignId, projectId: 'arena' })
      expect(started?.authorization).toMatchObject({ runId: campaignId, confirmation: OVERNIGHT_CONFIRMATION_TEXT })
      expect((await invoke(page, 'arena.campaign', { campaignId })).campaign.overnight).toBe(true)
      // The failsafe was the first thing asked of Windows: 9 hours, forced.
      expect(powerLog(dataDir)[0]).toMatchObject({ operation: 'scheduleShutdown', ok: true, request: { purpose: 'failsafe', delaySeconds: 32_400, force: true } })
      await expect(page.getByTestId('arena-overnight-state')).toBeVisible()
      await screenshot(page, 'overnight-arena-2-panel')
      // Closing the window would keep the campaign alive in the tray.
      expect((await trayModel(app))?.visible).toBe(true)
      expect((await trayModel(app))?.tooltip).toContain('Overnight E2E campaign')

      const scheduled = await waitForOvernight(page, campaignId, ['POWER_ACTION_SCHEDULED'], 300_000)
      expect(scheduled.terminalReason).toBe('SUCCESS')
      expect(scheduled.powerAction).toMatchObject({ action: 'SHUTDOWN', mechanism: 'os_timer', forced: true })
      expect(summary(powerLog(dataDir))).toEqual(['scheduleShutdown:failsafe', 'cancelShutdown', 'scheduleShutdown:final'])
      expect((await invoke(page, 'arena.campaign', { campaignId })).campaign.state).toBe('completed')
      const report = await invoke(page, 'overnight.report', { runId: campaignId })
      expect(report.text).toContain('# NEXUS Overnight Arena Campaign')
      expect(existsSync(report.path ?? '')).toBe(true)
      expect(Date.parse(scheduled.reportSavedAt ?? '')).toBeLessThanOrEqual(Date.parse(scheduled.powerAction?.scheduledAt ?? ''))
      expect((await invoke(page, 'overnight.audit', { runId: campaignId })).map((a) => a.operation)).toEqual(['arm_failsafe', 'cancel_failsafe', 'schedule_final'])
      expect((await trayModel(app))?.status).toBe('SHUTDOWN SCHEDULED')
      await expect(page.getByTestId('arena-overnight-countdown')).toBeVisible()
      await screenshot(page, 'overnight-arena-3-scheduled')

      // While it is live, the Overnight page shows the campaign as a campaign, not as a mission, and links back to it.
      await page.getByTestId('nav-overnight').click()
      await expect(page.getByTestId(`overnight-card-${campaignId}`)).toContainText('Arena campaign: Overnight E2E campaign')
      await screenshot(page, 'overnight-arena-4-overnight-page')
      await page.getByTestId('overnight-open-campaign').click()
      await expect(page.getByTestId('arena-overnight-panel')).toBeVisible()

      // The person at the keyboard cancels the shutdown from the campaign page.
      await page.getByTestId('arena-overnight-cancel-shutdown').click()
      const done = await waitForOvernight(page, campaignId, ['DONE'])
      expect(done.powerAction?.cancelledAt).not.toBeNull()
      expect(summary(powerLog(dataDir)).at(-1)).toBe('cancelShutdown')
      await expect(page.getByTestId('arena-overnight-report')).toBeVisible()
    } finally {
      await closeApp(app)
    }
  })

  test('the renderer cannot ask for arbitrary power commands', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      const projectId = await openProject(page)
      const call = (channel: string, input: unknown): Promise<{ ok: boolean; error?: { code: string } }> =>
        page.evaluate(([c, i]) => (globalThis as unknown as { nexus: { invoke: (c: string, i: unknown) => Promise<never> } }).nexus.invoke(c as string, i), [channel, input] as const)
      const base = { projectId, preset: 'balanced', prompt: 'x', policy: DEFAULT_OVERNIGHT_POLICY, confirmed: true, confirmation: OVERNIGHT_CONFIRMATION_TEXT }
      for (const input of [
        { ...base, confirmed: false },
        { ...base, confirmation: 'ok' },
        { ...base, command: 'shutdown.exe /r /t 0' },
        { ...base, policy: { ...DEFAULT_OVERNIGHT_POLICY, endAction: 'shutdown /r' } },
        { ...base, policy: { ...DEFAULT_OVERNIGHT_POLICY, args: ['/r'] } },
        { ...base, policy: { ...DEFAULT_OVERNIGHT_POLICY, finalDelaySeconds: '0 /f' } },
      ]) {
        expect(await call('overnight.start', input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      }
      for (const channel of ['power.shutdown', 'power.schedule', 'overnight.shutdown', 'overnight.power']) {
        expect(await call(channel, { delaySeconds: 0 })).toMatchObject({ ok: false })
      }
      expect(await invoke(page, 'runs.list', {})).toHaveLength(0)
      expect(powerLog(dataDir)).toEqual([])
    } finally {
      await closeApp(app)
    }
  })
})
