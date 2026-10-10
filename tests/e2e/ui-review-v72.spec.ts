import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { closeApp, createRepo, invoke, launchApp, REPO_ROOT, tempDir } from './helpers'

/**
 * Screenshot capture of the 0.7.2 screens for a UI review (`NEXUS_UI_REVIEW=1`). Not an assertion suite. With the
 * scripted runtime and no ChatGPT connection it shows: the Providers page with the ChatGPT card signed out, the
 * Director with a request that waits for a provider and its saved escalation, and the mission composer with a
 * compilation that waits and one that is ready. Light and dark, wide and narrow, under `test-results/ui-review/`.
 */
const OUT = join(REPO_ROOT, 'test-results', 'ui-review')
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
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
}

test.describe('UI review capture: 0.7.2 screens', () => {
  test.skip(process.env['NEXUS_UI_REVIEW'] !== '1', 'Run with NEXUS_UI_REVIEW=1')

  test('providers, director and the compilation preview, light and dark, wide and narrow', async () => {
    test.setTimeout(600_000)
    const repo = createRepo()
    const dataDir = tempDir('ui-review-v72')
    const { app, page } = await launchApp(dataDir, repo)
    try {
      await resize(app, 1440, 900)
      await page.getByTestId('nav-projects').click()
      await page.getByTestId('open-project').click()
      await expect(page.getByTestId('project-detail')).toBeVisible()
      const project = (await invoke(page, 'projects.list', {}))[0]
      if (!project) throw new Error('no project')
      // A Director request that waits (no ChatGPT here) and a saved escalation.
      await invoke(page, 'director.invoke', { projectId: project.id, objective: 'Should the retry of the uploader move to exponential backoff now, or after the missing tests?', level: 2 })
      await invoke(page, 'director.escalate', { projectId: project.id, objective: 'Review the plan of the storage migration before it starts.', level: 3, reasons: ['The two reviewers disagree'] })

      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme)
        for (const size of SIZES) {
          await resize(app, size.width, size.height)
          const name = (what: string): string => `v72-${theme}-${size.name}-${what}`

          await page.getByTestId('nav-providers').click()
          await expect(page.getByTestId('chatgpt-card')).toBeVisible()
          await page.getByTestId('chatgpt-card').scrollIntoViewIfNeeded()
          await shot(page, name('providers-chatgpt'))

          await page.getByTestId('nav-director').click()
          await page.getByLabel('Project', { exact: true }).selectOption(project.id)
          await expect(page.getByText('Waiting for a provider', { exact: true }).first()).toBeVisible()
          await shot(page, name('director-top'))
          await page.getByText('Escalation · Saved, not sent', { exact: true }).scrollIntoViewIfNeeded()
          await shot(page, name('director-records'))

          await page.getByTestId('nav-projects').click()
          await expect(page.getByTestId('mission-composer')).toBeVisible()
          await page.getByTestId('mission-prompt').fill('Replace the fixed retry delay with exponential backoff and add a test that does not sleep.')
          const preview = page.getByTestId('compilation-preview')
          if (!(await preview.evaluate((el) => (el as HTMLDetailsElement).open))) await preview.locator('summary').click()
          await page.getByTestId('compilation-mode').selectOption('STANDARD')
          await preview.getByRole('button', { name: 'Preview specification', exact: true }).click()
          await expect(preview.getByText('Waiting for a configured provider', { exact: true })).toBeVisible()
          await preview.scrollIntoViewIfNeeded()
          await shot(page, name('composer-preview-waiting'))
          await page.getByTestId('compilation-mode').selectOption('EXACT')
          await preview.getByRole('button', { name: 'Preview specification', exact: true }).click()
          await expect(preview.getByText('Specification preview ready', { exact: true })).toBeVisible()
          await preview.scrollIntoViewIfNeeded()
          await shot(page, name('composer-preview-ready'))
        }
      }
    } finally {
      await closeApp(app)
    }
  })
})
