import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { ProgramDetail } from '../../src/shared/program'
import {
  closeApp,
  createRepo,
  git,
  invoke,
  launchApp,
  removeDir,
  screenshot,
  tempDir,
  selectExactCompilation,
} from './helpers'

/**
 * NEXUS 0.4 against the built app with the scripted runtime: a program from the dialog to completion, plan
 * approval and a reassessment the user asks for, a restart in the middle of a program, and background
 * engineering. No real Claude session is used. The scripted runtime rejects the first milestone it judges
 * once (with a backlog proposal and a memory entry) and accepts everything after that.
 */
async function openProject(page: Page): Promise<string> {
  await page.getByTestId('nav-projects').click()
  await page.getByTestId('open-project').click()
  await expect(page.getByTestId('project-detail')).toBeVisible()
  const project = (await invoke(page, 'projects.list', {}))[0]
  if (!project) throw new Error('The project was not opened')
  return project.id
}

async function waitForProgram(page: Page, programId: string, done: (d: ProgramDetail) => boolean, timeout = 240_000): Promise<ProgramDetail> {
  let last: ProgramDetail | null = null
  await expect
    .poll(
      async () => {
        last = await invoke(page, 'program.get', { programId })
        return done(last)
      },
      { timeout, intervals: [1000], message: 'the program to reach the expected state' },
    )
    .toBe(true)
  if (!last) throw new Error('No program')
  return last
}

test.describe('NEXUS 0.4 programs', () => {
  const dirs: string[] = []
  test.afterAll(() => {
    for (const d of dirs) removeDir(d)
  })

  test('a program from the dialog to completion: milestones, a rejection, backlog, memory, the program branch', async () => {
    test.setTimeout(420_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await openProject(page)
      const userHead = git(repo, 'rev-parse', 'HEAD')
      await page.getByTestId('nav-programs').click()
      await expect(page.getByTestId('view-programs')).toBeVisible()
      await expect(page.getByTestId('programs-empty')).toBeVisible()
      await screenshot(page, 'v4-programs-empty')

      await page.getByTestId('programs-new').click()
      const dialog = page.getByTestId('program-dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByTestId('program-create-start')).toBeDisabled()
      await dialog.getByTestId('program-name').fill('Modules program')
      await dialog.getByTestId('program-goal').fill('Build the API and UI modules, integrate them, then harden the integration.')
      await dialog.getByTestId('program-preset-autonomous').click()
      await selectExactCompilation(page)
      await screenshot(page, 'v4-program-dialog')
      await dialog.getByTestId('program-create-start').click()

      await expect(page.getByTestId('program-page')).toBeVisible({ timeout: 30_000 })
      const programId = (await invoke(page, 'program.list', {})).programs[0]?.program.id ?? ''
      // While it works the page shows the roadmap and the state.
      await waitForProgram(page, programId, (d) => d.roadmap.length === 2)
      await expect(page.getByTestId('program-roadmap')).toBeVisible()
      await expect(page.getByTestId('milestone-foundation')).toBeVisible()
      await screenshot(page, 'v4-program-running')

      const done = await waitForProgram(page, programId, (d) => ['COMPLETED', 'BLOCKED', 'FAILED'].includes(d.program.state), 360_000)
      expect(done.program.state, done.program.blockedReason ?? '').toBe('COMPLETED')
      await expect(page.getByTestId('program-state')).toHaveAttribute('data-state', 'COMPLETED')
      // The first milestone was rejected once and needed a second mission; the second went through.
      expect(done.roadmap.map((m) => [m.key, m.state, m.attempts])).toEqual([
        ['foundation', 'COMPLETED', 2],
        ['hardening', 'COMPLETED', 1],
      ])
      expect(done.program).toMatchObject({ missions: 3, planVersion: 1 })
      expect(done.missions.map((m) => m.outcome)).toEqual(['completed', 'completed', 'completed'])
      expect(done.roadmap[0]?.evidence).toMatchObject({ verdict: 'accepted' })
      expect(done.roadmap[0]?.evidence?.gates.every((g) => g.passed)).toBe(true)
      expect(done.backlog.map((b) => [b.title, b.status, b.provenance.source])).toEqual([['No test covers the integration file', 'proposed', 'milestone_verifier']])
      expect(done.memory.map((m) => m.title)).toEqual(['Module files are the integration contract'])
      expect(done.decisions.map((d) => d.kind)).toEqual(expect.arrayContaining(['plan_accepted', 'milestone_rejected', 'milestone_accepted', 'completed']))
      // Each mission started from the one before; the accepted work is on the program branch only.
      expect(done.missions[1]?.baseCommit).toBe(done.missions[0]?.resultCommit)
      expect(done.missions[2]?.baseCommit).toBe(done.missions[1]?.resultCommit)
      expect(git(repo, 'rev-parse', done.program.branch ?? '')).toBe(done.missions[2]?.resultCommit)
      expect(git(repo, 'ls-tree', '--name-only', done.program.branch ?? '').split('\n')).toEqual(expect.arrayContaining(['api.txt', 'ui.txt', 'integration.txt']))
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(userHead)
      expect(git(repo, 'status', '--porcelain')).toBe('')
      expect(existsSync(join(repo, 'api.txt'))).toBe(false)

      // The page shows what happened.
      await expect(page.getByTestId('milestone-foundation')).toHaveAttribute('data-state', 'COMPLETED')
      await expect(page.getByTestId('milestone-hardening')).toHaveAttribute('data-state', 'COMPLETED')
      await screenshot(page, 'v4-program-completed')
      await page.getByTestId('program-tab-backlog').click()
      await expect(page.getByTestId('program-backlog')).toContainText('No test covers the integration file')
      await expect(page.getByTestId('program-backlog-note')).toBeVisible()
      await page.getByTestId('program-tab-memory').click()
      await expect(page.getByTestId('program-memory')).toContainText('Module files are the integration contract')
      await page.getByTestId('program-tab-revisions').click()
      await expect(page.getByTestId('program-revision-1')).toBeVisible()
      await page.getByTestId('program-tab-roadmap').click()

      // The list shows the program with its progress.
      await page.getByTestId('nav-programs').click()
      await expect(page.getByTestId('programs-view')).toContainText('Modules program')
      await screenshot(page, 'v4-programs-list')
    } finally {
      await closeApp(app)
    }
  })

  test('plan approval, a reassessment the user asks for, and a restart in the middle of the program', async () => {
    test.setTimeout(480_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    let launched = await launchApp(dataDir, repo)
    try {
      let page = launched.page
      const projectId = await openProject(page)
      // Balanced: the first plan waits for the user.
      const program = await invoke(page, 'program.create', {
        projectId,
        name: 'Approved program',
        goal: 'Build the modules and harden them.',
        preset: 'balanced',
        start: true,
        compilationMode: 'EXACT',
      })
      const waiting = await waitForProgram(page, program.id, (d) => d.program.state === 'PAUSED' && d.program.pauseReason === 'approval')
      expect(waiting.roadmap).toHaveLength(0)
      // The planner session is the program's own: it is not in the user's list of missions.
      expect(await invoke(page, 'runs.list', {})).toHaveLength(0)
      expect((await invoke(page, 'runs.list', { includeInternal: true })).map((r) => r.mode)).toEqual(['ask'])
      await page.getByTestId('nav-programs').click()
      await page.getByTestId(`program-row-${program.id}`).click()
      await expect(page.getByTestId('program-plan-approval')).toBeVisible()
      await screenshot(page, 'v4-plan-approval')
      await page.getByTestId('program-plan-accept').click()
      await waitForProgram(page, program.id, (d) => d.roadmap.length === 2 && d.program.missions >= 1)

      // The user asks for one more milestone; it is planned at the next reassessment.
      await page.getByTestId('program-replan').click()
      await expect(page.getByTestId('program-replan-submit')).toBeDisabled()
      await page.getByTestId('program-replan-note').fill('Add a final milestone that documents the modules.')
      await page
        .getByTestId('program-replan-dialog')
        .getByTestId('compilation-preview')
        .locator('summary')
        .first()
        .click()
      await page
        .getByTestId('program-replan-dialog')
        .getByTestId('compilation-mode')
        .selectOption('EXACT')
      await page.getByTestId('program-replan-submit').click()
      const revised = await waitForProgram(page, program.id, (d) => d.revisions.some((r) => r.trigger === 'user' && r.status === 'accepted'), 300_000)
      const revision = revised.revisions.find((r) => r.trigger === 'user')
      expect(revision?.diff.added).toEqual(['requested'])
      expect(revised.roadmap.map((m) => m.key)).toContain('requested')

      // Quit NEXUS while a mission is running and start it again: a balanced program continues by itself.
      await waitForProgram(page, program.id, (d) => d.program.currentRunKind === 'mission')
      const before = await invoke(page, 'program.get', { programId: program.id })
      await closeApp(launched.app)
      launched = await launchApp(dataDir, repo)
      page = launched.page
      const after = await waitForProgram(page, program.id, (d) => d.decisions.some((x) => x.kind === 'recovered'), 60_000)
      expect(after.program.missions).toBeGreaterThanOrEqual(before.program.missions)
      const done = await waitForProgram(page, program.id, (d) => ['COMPLETED', 'BLOCKED', 'FAILED'].includes(d.program.state), 400_000)
      expect(done.program.state, done.program.blockedReason ?? '').toBe('COMPLETED')
      expect(done.roadmap.filter((m) => m.state === 'COMPLETED').map((m) => m.key)).toEqual(expect.arrayContaining(['foundation', 'hardening', 'requested']))
      // No milestone was worked on by more missions than the rejection explains.
      expect(done.roadmap.every((m) => m.attempts <= 2), JSON.stringify({ roadmap: done.roadmap.map((m) => [m.key, m.attempts]), missions: done.missions.map((m) => [m.attempt, m.outcome]), decisions: done.decisions.map((d) => `${d.kind}: ${d.summary}`).reverse() }, null, 1)).toBe(true)
    } finally {
      await closeApp(launched.app)
    }
  })

  test('background engineering is off by default, runs only when enabled, and only proposes', async () => {
    test.setTimeout(180_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    dirs.push(repo, dataDir)
    const { app, page } = await launchApp(dataDir, repo)
    try {
      const projectId = await openProject(page)
      expect(await invoke(page, 'background.settings', {})).toEqual({ enabled: false, kinds: [] })
      const call = (channel: string, input: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }> =>
        page.evaluate(([c, i]) => (globalThis as unknown as { nexus: { invoke: (c: string, i: unknown) => Promise<never> } }).nexus.invoke(c as string, i), [channel, input] as const)
      expect(await call('background.start', { projectId, kind: 'test_gap_analysis' })).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
      expect(await call('background.start', { projectId, kind: 'format_disk' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })

      await page.getByTestId('nav-programs').click()
      await expect(page.getByTestId('background-card')).toBeVisible()
      await expect(page.getByTestId('background-kind-test_gap_analysis')).toBeDisabled()
      await page.getByTestId('background-enabled').click()
      await expect.poll(async () => (await invoke(page, 'background.settings', {})).enabled).toBe(true)
      // Flake 2 (V0_9_FLAKES.md): the runtime had the setting, the window had not drawn it yet, and the click landed on
      // the checkbox while it was still disabled (the error showed `<input disabled ...>`). The window is waited for.
      await expect(page.getByTestId('background-kind-test_gap_analysis')).toBeEnabled()
      await page.getByTestId('background-kind-test_gap_analysis').check()
      await expect.poll(async () => (await invoke(page, 'background.settings', {})).kinds).toEqual(['test_gap_analysis'])
      await page.getByTestId('background-run-test_gap_analysis').click()
      await expect.poll(async () => (await invoke(page, 'background.jobs', { projectId }))[0]?.state, { timeout: 60_000, intervals: [500] }).toBe('completed')
      const job = (await invoke(page, 'background.jobs', { projectId }))[0]
      expect(job).toMatchObject({ kind: 'test_gap_analysis', proposals: 1 })
      const backlog = await invoke(page, 'backlog.list', { projectId })
      expect(backlog.map((b) => [b.title, b.status, b.provenance.source, b.programId])).toEqual([['The entry point has no test', 'proposed', 'background_job', null]])
      // Read-only: the only run is an `ask` run and the repository is as it was.
      expect((await invoke(page, 'runs.list', { includeInternal: true })).map((r) => r.mode)).toEqual(['ask'])
      expect(await invoke(page, 'runs.list', {})).toEqual([])
      expect(git(repo, 'status', '--porcelain')).toBe('')
      await expect(page.getByTestId('background-jobs')).toContainText(/completed/i)
      await screenshot(page, 'v4-background')
    } finally {
      await closeApp(app)
    }
  })
})
