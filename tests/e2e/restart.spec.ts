import { expect, test, type Page } from '@playwright/test'
import { closeApp, createRepo, dismissApprovalDrawer, invoke, launchApp, removeDir, tempDir } from './helpers'

async function startMission(page: Page): Promise<string> {
  await page.getByTestId('nav-projects').click()
  await page.getByTestId('open-project').click()
  await expect(page.getByTestId('project-detail')).toBeVisible()
  await page.getByTestId('mission-prompt').fill('Add an API module and a UI module, then integrate them.')
  await page.getByTestId('create-run').click()
  await expect(page.getByTestId('plan-panel')).toBeVisible()
  await dismissApprovalDrawer(page)
  const id = (await invoke(page, 'runs.list', {}))[0]?.id
  expect(id).toBeTruthy()
  return id ?? ''
}

test.describe('restart and recovery', () => {
  const dirs: string[] = []
  test.afterAll(() => {
    for (const d of dirs) removeDir(d)
  })

  test('a run awaiting plan approval survives a restart and can then finish', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)

    const first = await launchApp(dataDir, repo)
    const runId = await startMission(first.page).finally(() => closeApp(first.app))

    const second = await launchApp(dataDir, repo)
    try {
      const runs = await invoke(second.page, 'runs.list', {})
      expect(runs.map((r) => r.id)).toContain(runId)
      const detail = await invoke(second.page, 'runs.get', { runId })
      expect(detail.run.state).toBe('awaiting_approval')
      expect(detail.tasks.map((t) => t.key).sort()).toEqual(['api', 'integration', 'ui'])

      // The plan is still there and approvable after the restart.
      await second.page.getByTestId(`sidebar-run-${runId}`).click()
      await expect(second.page.getByTestId('plan-tasks')).toContainText('Create the API module')
      await second.page.getByTestId('plan-panel').getByTestId('approve-plan').click()
      await expect(second.page.getByTestId('run-state')).toHaveAttribute('data-state', 'completed', { timeout: 120_000 })
    } finally {
      await closeApp(second.app)
    }
  })

  test('a run interrupted mid-execution shows the recovery dialog and resumes to completion', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)

    const first = await launchApp(dataDir, repo)
    let runId = ''
    try {
      runId = await startMission(first.page)
      await first.page.getByTestId('plan-panel').getByTestId('approve-plan').click()
      // Wait until work is really in flight, then close the app.
      await expect
        .poll(async () => {
          const d = await invoke(first.page, 'runs.get', { runId })
          return d.tasks.some((t) => ['assigned', 'running'].includes(t.state))
        })
        .toBe(true)
    } finally {
      await closeApp(first.app)
    }

    const second = await launchApp(dataDir, repo)
    try {
      const detail = await invoke(second.page, 'runs.get', { runId })
      expect(detail.tasks.length).toBeGreaterThanOrEqual(3)

      await expect(second.page.getByTestId('recovery-item')).toBeVisible()
      await expect(second.page.getByTestId('recover-resume')).toBeVisible()
      await expect(second.page.getByTestId('recover-inspect')).toBeVisible()
      await expect(second.page.getByTestId('recover-cancel')).toBeVisible()

      await second.page.getByTestId('recover-resume').click()
      await expect(second.page.getByTestId('run-view')).toBeVisible()
      await expect(second.page.getByTestId('run-state')).toHaveAttribute('data-state', 'completed', { timeout: 150_000 })
      const summary = await invoke(second.page, 'runs.summary', { runId })
      expect(summary.tasksFailed).toBe(0)
      expect(summary.tasksCompleted).toBe(summary.tasksTotal)
      const finalDetail = await invoke(second.page, 'runs.get', { runId })
      expect(finalDetail.tasks.map((t) => t.key)).toEqual(expect.arrayContaining(['api', 'ui', 'integration']))
      // The task the api worker added through a graph proposal and both plan revisions survived the interruption.
      expect(finalDetail.tasks.map((t) => t.key)).toContain('docs')
      expect(finalDetail.tasks.find((t) => t.key === 'docs')?.state).toBe('completed')
      expect((await invoke(second.page, 'graph.revisions', { runId })).map((r) => r.version)).toEqual([1, 2])
    } finally {
      await closeApp(second.app)
    }
  })
})
