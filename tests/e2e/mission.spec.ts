import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, createRepo, dismissApprovalDrawer, git, invoke, launchApp, removeDir, screenshot, tempDir } from './helpers'

test.describe('mission happy path', () => {
  const dirs: string[] = []
  test.afterAll(() => {
    for (const d of dirs) removeDir(d)
  })

  test('plans, executes with a repair loop, reviews, completes and leaves the working tree untouched', async () => {
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      // The main window shows.
      expect(app.windows()).toHaveLength(1)
      expect(await page.title()).toBe('NEXUS')

      // Open the project through the real "Open Project" button (the native dialog is stubbed in main).
      await page.getByTestId('nav-projects').click()
      await page.getByTestId('open-project').click()
      const detail = page.getByTestId('project-detail')
      await expect(detail).toBeVisible()
      await expect(detail).toContainText('main')
      await expect(page.getByTestId('dirty-badge')).toHaveText('clean')
      await expect(page.getByTestId('mission-composer')).toBeVisible()

      // Compose a BUILD + BALANCED mission.
      await page.getByTestId('mission-prompt').fill('Add an API module and a UI module, then integrate them.')
      await page.getByTestId('mode-select').selectOption('build')
      await page.getByTestId('preset-select').selectOption('balanced')
      await page.getByTestId('create-run').click()

      // The planner's plan is shown while the run awaits approval.
      await expect(page.getByTestId('run-view')).toBeVisible()
      const plan = page.getByTestId('plan-panel')
      await expect(plan).toBeVisible()
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'awaiting_approval')
      const planTasks = page.getByTestId('plan-tasks')
      await expect(planTasks).toContainText('Create the API module')
      await expect(planTasks).toContainText('Create the UI module')
      await expect(planTasks).toContainText('Integrate API and UI')
      await expect(planTasks.locator('tbody tr')).toHaveCount(3)
      // The pending plan approval is flagged by the persistent approval bar.
      await expect(page.getByTestId('approval-bar')).toBeVisible()
      await dismissApprovalDrawer(page)
      await screenshot(page, '1-plan-panel')

      // Approve and watch the graph.
      await plan.getByTestId('approve-plan').click()
      await expect(page.getByTestId('task-graph')).toBeVisible()
      for (const key of ['api', 'ui', 'integration']) await expect(page.getByTestId(`task-node-${key}`)).toBeVisible()
      await expect(page.getByTestId('task-node-ui-fix1')).toBeVisible({ timeout: 90_000 })
      await screenshot(page, '2-running-dag')

      await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'completed', { timeout: 120_000 })
      await expect(page.getByTestId('mission-complete')).toBeVisible()

      // Durable data is the source of truth for the counts.
      const runId = (await invoke(page, 'runs.list', {}))[0]?.id
      expect(runId).toBeTruthy()
      if (!runId) return
      const summary = await invoke(page, 'runs.summary', { runId })
      const detailData = await invoke(page, 'runs.get', { runId })
      const keys = detailData.tasks.map((t) => t.key).sort()
      expect(keys).toEqual(['api', 'integration', 'ui', 'ui-fix1'])
      expect(summary.tasksTotal).toBe(4)
      expect(summary.tasksCompleted).toBe(4)
      expect(summary.tasksFailed).toBe(0)
      await expect(page.getByTestId('stat-tasks')).toContainText(`${summary.tasksCompleted}/${summary.tasksTotal}`)
      await expect(page.getByTestId('stat-reviews')).toContainText(`${summary.reviewsApproved}/${summary.reviewsTotal}`)
      await screenshot(page, '3-mission-complete')

      // Every task node reached completed.
      await page.getByTestId('stage-tab-graph').click()
      for (const key of ['api', 'ui', 'integration', 'ui-fix1']) {
        await expect(page.getByTestId(`task-node-${key}`)).toHaveAttribute('data-state', 'completed')
      }

      // A review happened: changes were requested, then a later review approved.
      const reviews = await invoke(page, 'reviews.list', { runId })
      const uiTask = detailData.tasks.find((t) => t.key === 'ui')
      const uiReviews = reviews
        .filter((r) => r.taskId === uiTask?.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      expect(uiReviews[0]?.verdict).toBe('changes_requested')
      expect(uiReviews.at(-1)?.verdict).toBe('approved')
      await page.getByTestId('bottom-tab-reviews').click()
      await expect(page.getByTestId('review-card').first()).toBeVisible()
      await expect(page.locator('[data-testid="review-card"][data-verdict="changes_requested"]').first()).toBeVisible()
      await expect(page.locator('[data-testid="review-card"][data-verdict="approved"]').first()).toBeVisible()

      // Timeline lists events.
      await page.getByTestId('bottom-tab-timeline').click()
      await expect(page.getByTestId('timeline-row').first()).toBeVisible()
      const events = await invoke(page, 'events.list', { runId })
      expect(events.length).toBeGreaterThan(10)

      // Open a task diff from the inspector and see the created file.
      await page.getByTestId('task-node-api').click()
      await expect(page.getByTestId('task-inspector')).toHaveAttribute('data-task-id', /.+/)
      await page.getByTestId('inspector-tab-diff').click()
      await expect(page.getByTestId('diff-file-api.txt')).toBeVisible()

      // The Agents view shows output for a worker.
      await page.getByTestId('nav-agents').click()
      await expect(page.getByTestId('agents-view')).toBeVisible()
      const worker = detailData.agents.find((a) => a.role === 'worker')
      expect(worker).toBeTruthy()
      if (worker) await page.getByTestId(`agent-row-${worker.id}`).click()
      await expect(page.getByTestId('agent-output')).toContainText('Working on')

      // Git: the integration branch has all three files, the user's working tree has none.
      const branch = detailData.run.integrationBranch
      expect(branch).toBeTruthy()
      const files = git(repo, 'ls-tree', '-r', '--name-only', branch ?? 'missing').split(/\r?\n/)
      expect(files).toEqual(expect.arrayContaining(['api.txt', 'ui.txt', 'integration.txt']))
      for (const f of ['api.txt', 'ui.txt', 'integration.txt']) expect(existsSync(join(repo, f))).toBe(false)
      expect(git(repo, 'branch', '--show-current')).toBe('main')
      expect(git(repo, 'status', '--porcelain')).toBe('')
    } finally {
      await closeApp(app)
    }
  })

  test('renderer security posture', async () => {
    const dataDir = tempDir('data')
    dirs.push(dataDir)
    const { app, page } = await launchApp(dataDir, null)
    try {
      expect(await page.evaluate(() => typeof (globalThis as unknown as { require?: unknown }).require)).toBe('undefined')
      expect(await page.evaluate(() => typeof (globalThis as unknown as { process?: unknown }).process)).toBe('undefined')
      expect(await page.evaluate(() => Object.keys((globalThis as unknown as { nexus: object }).nexus).sort())).toEqual(['invoke', 'onPush'])
      const unknown = await page.evaluate(() =>
        (globalThis as unknown as { nexus: { invoke: (c: string, i: unknown) => Promise<{ ok: boolean }> } }).nexus.invoke('does.not.exist', {}),
      )
      expect(unknown.ok).toBe(false)
    } finally {
      await closeApp(app)
    }
  })
})
