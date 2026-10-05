import { expect, test, type Page } from '@playwright/test'
import type { ControlPlaneOverview } from '../../src/shared/control-plane'
import {
  closeApp,
  createRepo,
  dismissApprovalDrawer,
  invoke,
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
      await page.getByTestId('create-run').click()
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'awaiting_approval')
      const adopted = await waitForOverview(
        page,
        (o) => o.active.some((i) => i.type === 'mission'),
        'the mission to be adopted by the queue',
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
      await page.getByTestId(`schedule-remove-${schedule?.id ?? ''}`).click()
      await expect(page.getByTestId('control-schedules-empty')).toBeVisible()
    } finally {
      await closeApp(launched.app)
    }
  })
})
