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
const VIEWS = ['home', 'projects', 'run', 'agents', 'arena', 'policy', 'usage', 'performance', 'intelligence', 'overnight', 'activity', 'memory', 'settings'] as const
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
      const run = await invoke(page, 'runs.create', { projectId: project.id, mode: 'mission', preset: 'balanced', prompt: 'Add an API module and a UI module, then integrate them.', strategy: 'SINGLE', requirePlanApproval: false } as never)
      const runId = (run as { id: string }).id
      await expect.poll(async () => (await invoke(page, 'runs.get', { runId })).run.state, { timeout: 180_000, intervals: [1000] }).toMatch(/completed|failed|awaiting_approval/)

      // A finished Arena campaign, then an overnight campaign left in its final countdown.
      const cases = await invoke(page, 'arena.cases', {})
      const caseId = cases.find((c) => c.case.id === 'bugfix-localized')?.case.id ?? cases[0]!.case.id
      const campaign = await invoke(page, 'arena.createCampaign', { name: 'Review campaign', caseIds: [caseId], strategies: ['SINGLE', 'BUILD'], repetitions: 1, modelPreset: 'balanced', budgetPreset: 'eco', start: true })
      await expect.poll(async () => (await invoke(page, 'arena.campaign', { campaignId: campaign.id })).campaign.state, { timeout: 300_000, intervals: [1000] }).toBe('completed')
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
