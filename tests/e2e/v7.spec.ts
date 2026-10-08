import { selectExactCompilation } from './helpers'
import { expect, test, type Page } from '@playwright/test'
import type { ControlPlaneOverview } from '../../src/shared/control-plane'
import type { ConnectionState } from '../../src/shared/runtime-protocol'
import { IPC_INVOKE_CHANNEL } from '../../src/shared/ipc-channels'
import {
  closeApp,
  createRepo,
  dismissApprovalDrawer,
  invoke,
  killRuntime,
  launchApp,
  removeDir,
  screenshot,
  tempDir,
} from './helpers'

/**
 * NEXUS 0.7 against the built app with the scripted runtime: the Control Center, a mission adopted by the
 * global queue, a program started from the queue, limits, a durable schedule, and the queue after a restart.
 */
async function openProject(page: Page): Promise<string> {
  await page.getByTestId('nav-projects').click()
  await page.getByTestId('open-project').click()
  await expect(page.getByTestId('project-detail')).toBeVisible()
  const project = (await invoke(page, 'projects.list', {}))[0]
  if (!project) throw new Error('The project was not opened')
  return project.id
}

async function waitForOverview(
  page: Page,
  done: (o: ControlPlaneOverview) => boolean,
  message: string,
  timeout = 180_000,
): Promise<ControlPlaneOverview> {
  let last: ControlPlaneOverview | null = null
  await expect
    .poll(
      async () => {
        last = await invoke(page, 'control.overview', {})
        return done(last)
      },
      { timeout, intervals: [500], message },
    )
    .toBe(true)
  if (!last) throw new Error('No overview')
  return last
}

test.describe('NEXUS 0.7 control plane', () => {
  const dirs: string[] = []
  test.afterAll(() => {
    for (const d of dirs) removeDir(d)
  })

  test('the Control Center: health, an adopted mission, a program from the queue, limits, a schedule, and a restart', async () => {
    test.setTimeout(600_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    let launched = await launchApp(dataDir, repo)
    try {
      let page = launched.page
      await page.getByTestId('nav-control').click()
      await expect(page.getByTestId('control-page')).toBeVisible()
      await expect(page.getByTestId('control-health')).toHaveText('Runtime healthy')
      for (const part of [
        'database',
        'scheduler',
        'workers',
        'providers',
        'git',
        'usage',
        'power_supervisor',
        'ipc',
      ])
        await expect(page.getByTestId(`health-${part}`)).toHaveAttribute('data-level', 'HEALTHY')
      // The window reached READY: no startup state and no connection banner are left.
      await expect(page.getByTestId('startup-state')).toHaveCount(0)
      await expect(page.getByTestId('connection-banner')).toHaveCount(0)
      expect((await invoke(page, 'desktop.connection', {})).phase).toBe('READY')
      await expect(page.getByTestId('control-runtime')).toContainText('Healthy')
      await expect(page.getByTestId('control-claude')).toContainText('Available')
      // Without worker processes the strip says where sessions run.
      await expect(page.getByTestId('control-workers')).toBeVisible()

      // Dispatch is paused and resumed from the header; a pause says that running work continues.
      const toggle = page.getByTestId('dispatch-toggle')
      await expect(toggle).toHaveText('Pause dispatch')
      await toggle.click()
      await expect(toggle).toHaveText('Resume dispatch')
      await expect(page.getByTestId('control-dispatch-paused')).toContainText('Work that is running continues')
      expect((await invoke(page, 'control.overview', {})).dispatchPaused).toBe(true)
      await toggle.click()
      await expect(toggle).toHaveText('Pause dispatch')
      await expect(page.getByTestId('control-dispatch-paused')).toHaveCount(0)
      expect((await invoke(page, 'control.overview', {})).dispatchPaused).toBe(false)

      // Runtime diagnostics are closed until asked for; the stop button asks first and Escape keeps the runtime.
      await expect(page.getByTestId('runtime-diagnostics-body')).toHaveCount(0)
      await page.getByTestId('runtime-diagnostics-toggle').click()
      await expect(page.getByTestId('runtime-diagnostics-body')).toContainText('Process')
      await page.getByTestId('runtime-shutdown').click()
      await expect(page.getByTestId('runtime-shutdown-dialog')).toContainText('Closing only the window stops nothing')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('runtime-shutdown-dialog')).toHaveCount(0)
      expect((await invoke(page, 'runtime.status', {})).phase).toBe('READY')
      await expect(page.getByTestId('control-capacity-line')).toHaveText(
        '0 of 6 agents in use · 0 of 4 workloads running',
      )
      await expect(page.getByTestId('control-active-empty')).toBeVisible()
      await expect(page.getByTestId('control-waiting-empty')).toBeVisible()
      await expect(page.getByTestId('control-schedules-empty')).toBeVisible()
      await screenshot(page, 'v7-control-empty')

      // Limits are set here and persisted.
      await page.getByTestId('control-max-agents').selectOption('3')
      await expect(page.getByTestId('control-capacity-line')).toContainText('of 3 agents')
      expect((await invoke(page, 'control.overview', {})).limits).toMatchObject({
        maxAgents: 3,
        maxActiveItems: 4,
        resumeOnBoot: 'hold',
      })

      // A mission started from the composer is adopted by the queue while it runs.
      const projectId = await openProject(page)
      await page
        .getByTestId('mission-prompt')
        .fill('Add an API module and a UI module, then integrate them.')
      await page.getByTestId('mode-select').selectOption('build')
      await page.getByTestId('strategy-select').selectOption('BUILD')
      await page.getByTestId('preset-select').selectOption('balanced')
      await selectExactCompilation(page)
      await page.getByTestId('create-run').click()
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'awaiting_approval')
      const adopted = await waitForOverview(
        page,
        (o) => o.active.some((i) => i.type === 'mission' && i.detail === 'Waiting for your approval of the plan.'),
        'the adopted mission to report its pending plan approval',
      )
      const mission = adopted.active.find((i) => i.type === 'mission')
      expect(mission).toMatchObject({
        state: 'RUNNING',
        priority: 'P2',
        detail: 'Waiting for your approval of the plan.',
      })
      await dismissApprovalDrawer(page)
      await page.getByTestId('plan-panel').getByTestId('approve-plan').click()
      // While it works its sessions are counted against the global limit, and never exceed it.
      let peak = 0
      await expect
        .poll(
          async () => {
            const o = await invoke(page, 'control.overview', {})
            peak = Math.max(peak, o.agents.active)
            expect(o.agents.active).toBeLessThanOrEqual(3)
            return o.finished.some((i) => i.id === mission?.id)
          },
          { timeout: 240_000, intervals: [300], message: 'the adopted mission to finish' },
        )
        .toBe(true)
      expect(
        (await invoke(page, 'control.overview', {})).finished.find((i) => i.id === mission?.id),
      ).toMatchObject({ state: 'COMPLETED' })

      // A draft program is put on the queue from the Control Center and started by the scheduler.
      const program = await invoke(page, 'program.create', {
        projectId,
        name: 'Queued program',
        goal: 'Build the modules and harden them.',
        preset: 'autonomous',
        start: false,
      })
      await page.getByTestId('nav-control').click()
      await page.getByTestId('control-enqueue-program').selectOption(program.id)
      await page.getByTestId('control-enqueue-priority').selectOption('P1')
      await page.getByTestId('control-enqueue-submit').click()
      const started = await waitForOverview(
        page,
        (o) => o.active.some((i) => i.refId === program.id),
        'the program to be started from the queue',
      )
      const item = started.active.find((i) => i.refId === program.id)
      expect(item).toMatchObject({
        type: 'program',
        priority: 'P1',
        state: 'RUNNING',
        title: 'Queued program',
      })
      await expect(page.getByTestId(`work-item-${item?.id ?? ''}`)).toHaveAttribute(
        'data-state',
        'RUNNING',
      )
      await screenshot(page, 'v7-control-running')
      // The inspector explains what the scheduler decided about the item.
      await page.getByTestId(`work-item-open-${item?.id ?? ''}`).click()
      await expect(page.getByTestId('inspector-decisions')).toContainText('Scheduler decisions')
      await expect(page.getByTestId('inspector-decision-list')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('work-item-inspector')).toHaveCount(0)
      // The same program cannot be queued twice.
      const twice = await page.evaluate(
        async (programId) =>
          (
            globalThis as unknown as {
              nexus: {
                invoke(c: string, i: object): Promise<{ ok: boolean; error?: { message: string } }>
              }
            }
          ).nexus.invoke('control.enqueue', { item: { type: 'program', programId } }),
        program.id,
      )
      expect(twice.ok).toBe(false)
      expect(twice.error?.message ?? '').toContain('already on the queue')

      // A schedule is created from the form.
      await page.getByTestId('schedule-name').fill('Continue at night')
      await page.getByTestId('schedule-program').selectOption(program.id)
      await page.getByTestId('schedule-time').fill('22:00')
      await page.getByTestId('schedule-create').click()
      const withSchedule = await waitForOverview(
        page,
        (o) => o.schedules.length === 1,
        'the schedule to be stored',
      )
      const schedule = withSchedule.schedules[0]
      expect(schedule).toMatchObject({
        name: 'Continue at night',
        enabled: true,
        rule: { kind: 'daily', time: '22:00' },
        action: { type: 'program', programId: program.id },
      })
      expect(schedule?.nextRunAt).not.toBeNull()
      await expect(page.getByTestId(`schedule-${schedule?.id ?? ''}`)).toContainText(
        'Every day at 22:00',
      )

      const finished = await waitForOverview(
        page,
        (o) => o.finished.some((i) => i.refId === program.id),
        'the queued program to finish',
        420_000,
      )
      expect(finished.finished.find((i) => i.refId === program.id)).toMatchObject({
        state: 'COMPLETED',
      })
      expect((await invoke(page, 'program.get', { programId: program.id })).program.state).toBe(
        'COMPLETED',
      )
      await screenshot(page, 'v7-control-finished')

      // NEXUS is closed and started again: limits, the schedule and the history of the queue are as they were.
      await closeApp(launched.app)
      launched = await launchApp(dataDir, repo)
      page = launched.page
      const after = await waitForOverview(
        page,
        (o) => o.health.components.find((c) => c.component === 'scheduler')?.level === 'HEALTHY',
        'the control plane to run after the restart',
      )
      expect(after.limits).toMatchObject({ maxAgents: 3 })
      expect(after.schedules.map((s) => [s.id, s.enabled, s.nextRunAt])).toEqual([
        [schedule?.id, true, schedule?.nextRunAt],
      ])
      expect(after.finished.map((i) => i.state).sort()).toEqual(['COMPLETED', 'COMPLETED'])
      expect(after.active).toEqual([])
      await page.getByTestId('nav-control').click()
      await page.getByTestId(`schedule-enabled-${schedule?.id ?? ''}`).click()
      await waitForOverview(
        page,
        (o) => o.schedules[0]?.enabled === false && o.schedules[0]?.nextRunAt === null,
        'the schedule to be switched off',
      )
      // Deleting a schedule asks first; keeping it leaves it in place.
      const removeButton = page.getByTestId(`schedule-remove-${schedule?.id ?? ''}`)
      await removeButton.click()
      const deleteDialog = page.getByTestId('schedule-delete-dialog')
      await expect(deleteDialog).toContainText('Continue at night')
      await deleteDialog.getByRole('button', { name: 'Keep schedule' }).click()
      await expect(deleteDialog).toHaveCount(0)
      await expect(removeButton).toBeFocused()
      await expect(page.getByTestId(`schedule-${schedule?.id ?? ''}`)).toBeVisible()
      await removeButton.click()
      await deleteDialog.getByTestId('confirm-dialog-confirm').click()
      await expect(page.getByTestId('control-schedules-empty')).toBeVisible()
    } finally {
      await closeApp(launched.app)
    }
  })

  test('the Control Center shows a failed load with Retry, blocked and failed work, and asks before it cancels', async () => {
    test.setTimeout(120_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      // The overview is answered by a wrapper in the main process: first it fails, then it carries three
      // items that no scripted workload can produce on demand (a running arena campaign, a blocked program, a failed audit).
      await app.evaluate(({ ipcMain }, channel) => {
        type Reply = { ok: boolean; value?: Record<string, unknown[]>; error?: { code: string; message: string } }
        type Handler = (event: unknown, channel: string, input: unknown) => Promise<Reply> | Reply
        const state = globalThis as unknown as { __e2e?: { mode: string; calls: number } }
        if (state.__e2e) return
        state.__e2e = { mode: 'fail', calls: 0 }
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
        const original = handlers.get(channel)
        if (!original) throw new Error('No invoke handler to wrap')
        const at = new Date().toISOString()
        const item = (over: Record<string, unknown>): Record<string, unknown> => ({
          refId: null, priority: 'P2', position: 1, requestedAgents: 2, deadlineAt: null, notBefore: null, scheduleId: null,
          heldByUser: false, payload: null, detail: null, createdAt: at, updatedAt: at, startedAt: at, finishedAt: null, ...over,
        })
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (event, name: string, input: unknown) => {
          if (name !== 'control.overview') return original(event, name, input)
          if (state.__e2e) state.__e2e.calls += 1
          const mode = state.__e2e?.mode
          if (mode === 'fail') return { ok: false, error: { code: 'internal', message: 'The queue database is locked.' } }
          const reply = await original(event, name, input)
          if (mode === 'seed' && reply.ok && reply.value) {
            reply.value['active']?.push({ ...item({ id: 'e2e-running', type: 'arena', title: 'Nightly campaign', state: 'RUNNING' }), activeAgents: 2, allowance: 3 })
            reply.value['waiting']?.push({ ...item({ id: 'e2e-blocked', type: 'program', title: 'Blocked program', state: 'BLOCKED', detail: 'Milestone 2 could not start.' }), reason: 'Milestone 2 could not start.' })
            reply.value['finished']?.unshift(item({ id: 'e2e-failed', type: 'scheduled_audit', title: 'Dependency audit', state: 'FAILED', detail: 'The analysis run crashed.', finishedAt: at }))
            reply.value['incidents']?.unshift({ at, summary: 'Blocked program: Milestone 2 could not start.', itemId: 'e2e-blocked' })
          }
          return reply
        })
      }, IPC_INVOKE_CHANNEL)

      // A failed load is an error with its text and a Retry, never a permanent "Loading".
      await page.getByTestId('nav-control').click()
      await expect(page.getByTestId('control-load-error')).toBeVisible()
      await expect(page.getByTestId('control-load-error-text')).toHaveText('The queue database is locked.')
      await expect(page.getByTestId('control-loading')).toHaveCount(0)
      await screenshot(page, 'v7-control-load-error')
      // Retry is pressed while the load still fails: the button stays where it is and pressable, each press loads
      // again, and the error stays shown. (Once the load can succeed, the page's own refresh recovers within
      // seconds and the button is rightly gone, so pressing it is proven here, not after.)
      const calls = (): Promise<number> => app.evaluate(() => (globalThis as unknown as { __e2e: { calls: number } }).__e2e.calls)
      for (let press = 0; press < 3; press++) {
        const before = await calls()
        await page.getByTestId('control-retry').click()
        await expect.poll(calls).toBeGreaterThan(before)
        await expect(page.getByTestId('control-load-error')).toBeVisible()
      }
      await app.evaluate(() => {
        ;(globalThis as unknown as { __e2e: { mode: string } }).__e2e.mode = 'seed'
      })
      // Recovery needs no press: the next load, whoever asks for it, shows the page.
      await page.getByTestId('control-retry').click({ timeout: 2000 }).catch(() => undefined)
      await expect(page.getByTestId('control-load-error')).toHaveCount(0)
      await expect(page.getByTestId('control-page')).toBeVisible()

      // Blocked work is not an ordinary queued job: its own group, a label, the reason and what to do.
      const blocked = page.getByTestId('work-item-e2e-blocked')
      await expect(page.getByTestId('control-attention')).toContainText('Needs attention (1)')
      await expect(blocked).toHaveAttribute('data-emphasis', 'attention')
      await expect(page.getByTestId('work-item-badge-e2e-blocked')).toHaveText('Blocked')
      await expect(page.getByTestId('work-item-reason-e2e-blocked')).toContainText('Blocked because: Milestone 2 could not start.')
      await expect(page.getByTestId('finished-e2e-failed')).toHaveAttribute('data-emphasis', 'failure')
      await expect(page.getByTestId('finished-reason-e2e-failed')).toContainText('Failed because: The analysis run crashed.')
      await screenshot(page, 'v7-control-blocked')

      // The inspector opens from the title, shows the reason and the item's events, and returns focus on Escape.
      const open = page.getByTestId('work-item-open-e2e-blocked')
      await open.click()
      const inspector = page.getByTestId('work-item-inspector')
      await expect(inspector).toBeVisible()
      await expect(page.getByTestId('inspector-reason')).toContainText('Milestone 2 could not start.')
      await expect(page.getByTestId('inspector-events')).toContainText('Milestone 2 could not start.')
      await expect(inspector).toContainText('Priority')
      await expect(inspector).toContainText('Agents')
      await page.keyboard.press('Escape')
      await expect(inspector).toHaveCount(0)
      await expect(open).toBeFocused()

      // Cancelling work that runs asks first: what stops, how many sessions, what is kept; Escape keeps it.
      const cancel = page.getByTestId('work-item-cancel-e2e-running')
      await cancel.click()
      const dialog = page.getByTestId('cancel-dialog-e2e-running')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Nightly campaign')
      await expect(dialog).toContainText('Arena campaign')
      await expect(dialog).toContainText('2 running agent sessions will be stopped at once')
      await expect(dialog.getByTestId('confirm-preserved')).toContainText('Trials that already finished keep their results.')
      await expect(dialog.getByRole('button', { name: 'Keep it running' })).toBeFocused()
      await screenshot(page, 'v7-control-cancel-dialog')
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(cancel).toBeFocused()
      // The item does not exist in the queue, so the confirmed cancel fails: the error stays in the dialog and the page works.
      await cancel.click()
      await dialog.getByTestId('confirm-dialog-confirm').click()
      await expect(dialog.getByRole('alert')).toBeVisible()
      await dialog.getByRole('button', { name: 'Keep it running' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('work-item-e2e-running')).toBeVisible()
    } finally {
      await closeApp(app)
    }
  })

  test('with worker processes the sessions of a program appear as worker rows', async () => {
    test.setTimeout(420_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo, { NEXUS_FAKE_WORKERS: '1' })
    try {
      await openProject(page)
      const projectId = (await invoke(page, 'projects.list', {}))[0]?.id ?? ''
      const program = await invoke(page, 'program.create', {
        projectId,
        name: 'Worker program',
        goal: 'Build the modules and harden them.',
        preset: 'autonomous',
        start: false,
      })
      await page.getByTestId('nav-control').click()
      await page.getByTestId('control-enqueue-program').selectOption(program.id)
      await page.getByTestId('control-enqueue-submit').click()
      await waitForOverview(page, (o) => o.active.some((i) => i.refId === program.id), 'the program to start')
      // The header counts worker processes, not "inside the runtime".
      await expect(page.getByTestId('control-workers')).not.toContainText('Inside the runtime')
      await page.getByTestId('runtime-diagnostics-toggle').click()
      await expect(page.getByTestId('workers-table')).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('[data-testid^="worker-row-"]').first()).toBeVisible()
      await expect(page.getByTestId('leases-table')).toBeVisible()
      await screenshot(page, 'v7-control-workers')
    } finally {
      await closeApp(app)
    }
  })

  test('a lost connection is shown as stale and inert, and the window re-reads everything when it is back', async () => {
    test.setTimeout(180_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await page.getByTestId('nav-control').click()
      await expect(page.getByTestId('control-capacity-line')).toBeVisible()
      await expect(page.getByTestId('connection-banner')).toHaveCount(0)

      killRuntime(dataDir)
      const banner = page.getByTestId('connection-banner')
      await expect(banner).toBeVisible({ timeout: 30_000 })
      await expect(banner).toHaveAttribute('data-phase', /DISCONNECTED|CONNECTING|STARTING_RUNTIME|RECOVERING/)
      // While it is lost the content is marked stale and cannot be operated; the banner can.
      await expect.poll(async () => page.getByTestId('connection-content').getAttribute('data-stale'), { timeout: 30_000 }).toBe('true')
      await expect(page.getByTestId('connection-content')).toHaveAttribute('inert', '')
      await expect(page.getByTestId('connection-retry')).toBeEnabled()
      await page.getByTestId('connection-diagnostics').click()
      await expect(page.getByTestId('connection-diagnostics-panel')).toContainText('Attempts')
      await screenshot(page, 'v7-control-disconnected')

      // The window's main process starts the runtime again; the banner goes and the data is fresh.
      await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 120_000 })
      await expect(page.getByTestId('connection-content')).toHaveAttribute('data-stale', 'false')
      const connection: ConnectionState = await invoke(page, 'desktop.connection', {})
      expect(connection.phase).toBe('READY')
      await expect(page.getByTestId('control-capacity-line')).toHaveText('0 of 6 agents in use · 0 of 4 workloads running')
      await expect(page.getByTestId('connection-announcer')).toContainText('Reconnected')
    } finally {
      await closeApp(app)
    }
  })
})
