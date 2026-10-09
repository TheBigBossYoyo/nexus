import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { DEFAULT_OVERNIGHT_POLICY, OVERNIGHT_CONFIRMATION_TEXT } from '../../src/shared/overnight'
import { closeApp, createRepo, invoke, launchApp, removeDir, REPO_ROOT, tempDir } from './helpers'

/**
 * Screenshot capture for a UI review (`NEXUS_UI_REVIEW=1 npx playwright test tests/e2e/ui-review.spec.ts`).
 * Not an assertion suite: it seeds a mission, an Arena campaign and an overnight campaign with the scripted
 * runtime, then stores every view in the light and the dark theme at two window sizes under
 * `test-results/ui-review/`. Skipped in a normal run.
 */
const OUT = join(REPO_ROOT, 'test-results', 'ui-review')
const VIEWS = ['home', 'projects', 'run', 'programs', 'agents', 'arena', 'policy', 'usage', 'performance', 'intelligence', 'overnight', 'activity', 'memory', 'settings'] as const
const SIZES = [
  { name: 'wide', width: 1440, height: 900 },
  { name: 'narrow', width: 1024, height: 700 },
] as const

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), { width, height })
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const settings = await invoke(page, 'settings.get', {})
  await invoke(page, 'settings.update', { settings: { ...settings, appearance: { ...settings.appearance, theme } } })
  await page.reload()
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

test.describe('UI review capture', () => {
  test.skip(process.env['NEXUS_UI_REVIEW'] !== '1', 'Run with NEXUS_UI_REVIEW=1')

  test('every view, light and dark, wide and narrow', async () => {
    test.setTimeout(900_000)
    const repo = createRepo()
    const dataDir = tempDir('data')
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await resize(app, 1440, 900)
      // A project and a finished mission.
      await page.getByTestId('nav-projects').click()
      await page.getByTestId('open-project').click()
      await expect(page.getByTestId('project-detail')).toBeVisible()
      const project = (await invoke(page, 'projects.list', {}))[0]
      if (!project) throw new Error('no project')
      await shot(page, 'light-wide-projects-composer')
      const run = await invoke(page, 'runs.create', { projectId: project.id, mode: 'mission', preset: 'balanced', compilationMode: 'EXACT', prompt: 'Add an API module and a UI module, then integrate them.', strategy: 'SINGLE', requirePlanApproval: false } as never)
      const runId = (run as { id: string }).id
      await expect.poll(async () => (await invoke(page, 'runs.get', { runId })).run.state, { timeout: 180_000, intervals: [1000] }).toMatch(/completed|failed|awaiting_approval/)

      // 0.4: one program that ran to completion (with a rejection, backlog and memory), one waiting for approval.
      const finished = await invoke(page, 'program.create', {
        projectId: project.id,
        name: 'Modules program', goal: 'Build the API and UI modules, integrate them, then harden the integration.',
        preset: 'autonomous',
        start: true,
        compilationMode: 'EXACT',
      })
      await expect.poll(async () => (await invoke(page, 'program.get', { programId: finished.id })).program.state, { timeout: 400_000, intervals: [1000] }).toMatch(/COMPLETED|BLOCKED|FAILED/)
      const awaiting = await invoke(page, 'program.create', {
        projectId: project.id,
        name: 'Billing rework',
        compilationMode: 'EXACT',
        goal: 'Rework the billing module in small verified steps.',
        preset: 'conservative',
        schedule: { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }] },
        start: true,
      })
      await expect.poll(async () => (await invoke(page, 'program.get', { programId: awaiting.id })).program.pauseReason, { timeout: 120_000, intervals: [1000] }).toBe('approval')
      await invoke(page, 'background.setSettings', { settings: { enabled: true, kinds: ['test_gap_analysis', 'dependency_audit'] } })
      await invoke(page, 'background.start', { projectId: project.id, kind: 'test_gap_analysis' })
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme)
        for (const size of SIZES) {
          await resize(app, size.width, size.height)
          await page.getByTestId('nav-programs').click()
          await page.getByTestId(`program-row-${finished.id}`).click()
          await expect(page.getByTestId('program-page')).toBeVisible()
          await shot(page, `${theme}-${size.name}-program-completed-roadmap`)
          if (size.name === 'wide') {
            for (const tab of ['missions', 'revisions', 'decisions', 'backlog', 'memory', 'expertise'] as const) {
              await page.getByTestId(`program-tab-${tab}`).click()
              await shot(page, `${theme}-wide-program-tab-${tab}`)
            }
          }
          await page.getByTestId('program-back').click()
          await page.getByTestId(`program-row-${awaiting.id}`).click()
          await expect(page.getByTestId('program-plan-approval')).toBeVisible()
          await shot(page, `${theme}-${size.name}-program-plan-approval`)
          await page.getByTestId('program-back').click()
          await shot(page, `${theme}-${size.name}-programs-list`)
          await page.getByTestId('programs-new').click()
          await expect(page.getByTestId('program-dialog')).toBeVisible()
          await shot(page, `${theme}-${size.name}-program-dialog-empty`)
          await page.getByTestId('program-name').fill('Search rework')
          await page.getByTestId('program-goal').fill('Replace the search index with an incremental one, in verified steps.')
          await page.getByTestId('program-preset-balanced').click()
          await page.getByTestId('program-window-enabled').check()
          await shot(page, `${theme}-${size.name}-program-dialog-filled`)
          await page.keyboard.press('Escape')
        }
        await resize(app, 1440, 900)
      }

      // A finished Arena campaign, then an overnight campaign left in its final countdown.
      const cases = await invoke(page, 'arena.cases', {})
      const caseId = cases.find((c) => c.case.id === 'bugfix-localized')?.case.id ?? cases[0]!.case.id
      const campaign = await invoke(page, 'arena.createCampaign', { name: 'Review campaign', caseIds: [caseId], strategies: ['SINGLE', 'BUILD'], repetitions: 1, modelPreset: 'balanced', budgetPreset: 'eco', start: true })
      await expect.poll(async () => (await invoke(page, 'arena.campaign', { campaignId: campaign.id })).campaign.state, { timeout: 300_000, intervals: [1000] }).toBe('completed')
      // The "Run overnight" form of the dialog, before any overnight workload exists (it is disabled while one is live).
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme)
        await page.getByTestId('nav-arena').click()
        await page.getByTestId('arena-new-campaign').click()
        const dialog = page.getByTestId('arena-campaign-dialog')
        await dialog.getByTestId('arena-campaign-name').fill('Overnight form')
        await dialog.getByTestId(`arena-case-${caseId}`).click()
        await dialog.getByTestId('arena-run-overnight').check()
        await expect(dialog.getByTestId('arena-overnight-form')).toBeVisible()
        await shot(page, `${theme}-wide-arena-dialog-overnight-form-top`)
        await dialog.getByTestId('arena-overnight-authorize').scrollIntoViewIfNeeded()
        await dialog.getByTestId('arena-overnight-authorize').check()
        await shot(page, `${theme}-wide-arena-dialog-overnight-form-authorized`)
        await page.keyboard.press('Escape')
        // Mission Control with the finished mission, a task open in the inspector, and the Agents page.
        await page.getByTestId('nav-run').click()
        await page.getByTestId('runs-table').locator('[data-testid^="run-row-"]').first().click()
        await expect(page.getByTestId('run-view')).toBeVisible()
        await shot(page, `${theme}-wide-mission-control`)
        const node = page.locator('.nexus-flow .react-flow__node').first()
        if (await node.count()) {
          await node.click()
          await shot(page, `${theme}-wide-mission-control-inspector`)
        }
        await resize(app, 1024, 700)
        await shot(page, `${theme}-narrow-mission-control`)
        await page.getByTestId('nav-agents').click()
        await shot(page, `${theme}-narrow-agents-with-mission`)
        await resize(app, 1440, 900)
        await shot(page, `${theme}-wide-agents-with-mission`)
        const agent = page.getByTestId('agents-panel').locator('button, a').first()
        if (await agent.count()) {
          await agent.click()
          await shot(page, `${theme}-wide-agents-detail`)
        }
      }
      const { campaignId } = await invoke(page, 'overnight.startArena', {
        campaign: { name: 'Overnight review campaign', caseIds: [caseId], strategies: ['SINGLE'], repetitions: 1, modelPreset: 'balanced', budgetPreset: 'eco' },
        policy: { ...DEFAULT_OVERNIGHT_POLICY, forceCloseApplications: true, finalDelaySeconds: 3600 },
        confirmed: true,
        confirmation: OVERNIGHT_CONFIRMATION_TEXT,
      })
      await expect.poll(async () => (await invoke(page, 'overnight.get', { runId: campaignId }))?.state, { timeout: 300_000, intervals: [1000] }).toBe('POWER_ACTION_SCHEDULED')

      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme)
        for (const size of SIZES) {
          await resize(app, size.width, size.height)
          for (const view of VIEWS) {
            await page.getByTestId(`nav-${view}`).click()
            await expect(page.getByTestId(`view-${view}`)).toBeVisible()
            await shot(page, `${theme}-${size.name}-${view}`)
          }
          // Mission Control with the finished mission, the Arena campaign page and its overnight panel, the new-campaign dialog.
          await page.getByTestId('nav-arena').click()
          await page.getByTestId('arena-new-campaign').click()
          await expect(page.getByTestId('arena-campaign-dialog')).toBeVisible()
          await page.getByTestId('arena-run-overnight').check({ force: true }).catch(() => undefined)
          await shot(page, `${theme}-${size.name}-arena-dialog-overnight`)
          await page.keyboard.press('Escape')
          await page.getByTestId('nav-overnight').click()
          const open = page.getByTestId('overnight-open-campaign')
          if (await open.count()) {
            await open.first().click()
            await expect(page.getByTestId('arena-overnight-panel')).toBeVisible()
            await shot(page, `${theme}-${size.name}-arena-campaign-overnight`)
          }
        }
        // Keyboard focus: tab through the shell and store what the focus ring looks like.
        await resize(app, 1440, 900)
        await page.getByTestId('nav-home').click()
        for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
        await shot(page, `${theme}-wide-home-keyboard-focus`)
      }
    } finally {
      await closeApp(app)
      removeDir(repo)
      removeDir(dataDir)
    }
  })
})
