import { expect, test } from '@playwright/test'
import { IPC_INVOKE_CHANNEL } from '../../src/shared/ipc-channels'
import {
  closeApp,
  createRepo,
  invoke,
  launchApp,
  removeDir,
  tempDir,
  selectExactCompilation,
} from './helpers'

test('AUTO waits for its provider and explicit EXACT preserves intent in an admitted run', async () => {
  const repo = createRepo(),
    dataDir = tempDir('compiler-admission-v72')
  const { app, page } = await launchApp(dataDir, repo)
  try {
    await page.getByTestId('nav-projects').click()
    await page.getByTestId('open-project').click()
    const raw = '  Fix leaderboard freeze\n'
    await page.getByTestId('mission-prompt').fill(raw)
    await app.evaluate(({ ipcMain }, channel) => {
      type Handler = (event: unknown, channel: string, input: unknown) => unknown
      const original = (
        ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers.get(channel)!
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, name: string, input: unknown) => {
        if (name === 'compilation.preview')
          await new Promise((resolve) => setTimeout(resolve, 1200))
        return original(event, name, input)
      })
    }, IPC_INVOKE_CHANNEL)
    await page.getByTestId('create-run').click()
    await expect(page.getByTestId('mission-form')).toHaveAttribute('disabled', '')
    await expect(page.getByTestId('mission-prompt')).toBeDisabled()
    await expect(page.getByTestId('mode-select')).toBeDisabled()
    await expect(page.getByText('Waiting for a configured provider', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('status').filter({ hasText: 'Mission has not started.' }),
    ).toBeFocused()
    await expect(page.getByTestId('mission-prompt')).toBeEnabled()
    await expect(page.getByTestId('mission-prompt')).toHaveValue(raw)
    expect(await invoke(page, 'runs.list', {})).toEqual([])
    await selectExactCompilation(page)
    await page.getByTestId('create-run').click()
    await expect(page.getByTestId('run-view')).toBeVisible()
    const run = (await invoke(page, 'runs.list', {}))[0]!
    expect(run.prompt).toBe(raw)
    expect(run.config.compiledTaskSpec?.rawIntent).toBe(raw)
    expect(run.config.compiledTaskSpec?.mode).toBe('EXACT')
  } finally {
    await closeApp(app)
    removeDir(dataDir)
    removeDir(repo)
  }
})

test('Director waiting history, exact compiler preview and protected provider controls', async () => {
  const repo = createRepo()
  const dataDir = tempDir('intelligence-v72')
  const { app, page } = await launchApp(dataDir, repo)
  try {
    await page.getByTestId('nav-projects').click()
    await page.getByTestId('open-project').click()
    await expect(page.getByTestId('project-detail')).toBeVisible()
    const project = (await invoke(page, 'projects.list', {}))[0]!
    const raw = '  Fix the spelling\n'
    const spec = await invoke(page, 'compilation.preview', {
      projectId: project.id,
      raw,
      mode: 'EXACT',
    })
    expect(spec.rawIntent).toBe(raw)
    expect(spec.status).toBe('READY')
    await page.getByTestId('nav-director').click()
    await page
      .getByLabel('Objective', { exact: true })
      .fill('Review security without starting work')
    await page.getByLabel('Director level').selectOption('3')
    await page.getByRole('button', { name: 'Request advice', exact: true }).click()
    await expect(page.getByText('WAITING FOR PROVIDER', { exact: true })).toBeVisible()
    expect(
      (await invoke(page, 'director.history', { projectId: project.id }))[0]?.executionAuthorized,
    ).toBe(false)
    await page.screenshot({ path: 'test-results/v72-director-light.png' })
    await page.getByTestId('nav-providers').click()
    await expect(page.getByTestId('chatgpt-card')).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Connect an account', exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: 'test-results/v72-providers-light.png' })
    const settings = await invoke(page, 'settings.get', {})
    await invoke(page, 'settings.update', {
      settings: { ...settings, appearance: { ...settings.appearance, theme: 'dark' } },
    })
    await page.reload()
    await page.getByTestId('nav-director').click()
    await page.getByLabel('Project', { exact: true }).selectOption(project.id)
    await expect(page.getByText('WAITING FOR PROVIDER', { exact: true })).toBeVisible()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1024, 700),
    )
    await page.screenshot({ path: 'test-results/v72-director-dark-narrow.png' })
  } finally {
    await closeApp(app)
    removeDir(dataDir)
    removeDir(repo)
  }
})

test('saved strategic escalations require explicit advice and preserve waiting outcomes and routing', async () => {
  const repo = createRepo(),
    dataDir = tempDir('director-escalation-v72')
  const { app, page } = await launchApp(dataDir, repo)
  try {
    await page.getByTestId('nav-projects').click()
    await page.getByTestId('open-project').click()
    await expect(page.getByTestId('project-detail')).toBeVisible()
    const project = (await invoke(page, 'projects.list', {}))[0]!
    await page.getByTestId('nav-director').click()
    const raw = '  Review conflicting engineering evidence\n'
    await page.getByLabel('Objective', { exact: true }).fill(raw)
    await page.getByLabel('Director level').selectOption('3')
    await page.getByRole('button', { name: 'Save escalation', exact: true }).click()
    const saved = page.getByText('Escalation · REQUESTED', { exact: true })
    await expect(saved).toBeVisible()
    expect(await invoke(page, 'director.history', { projectId: project.id })).toEqual([])
    await saved.focus()
    await saved.press('Enter')
    await page.getByRole('button', { name: 'Request escalation advice', exact: true }).click()
    await expect(page.getByText('Escalation · WAITING FOR PROVIDER', { exact: true })).toBeVisible()
    const invocation = (await invoke(page, 'director.history', { projectId: project.id }))[0]!
    expect(invocation.objective).toBe(raw)
    expect(invocation.executionAuthorized).toBe(false)
    expect(
      (await invoke(page, 'director.records', { projectId: project.id })).some(
        (r) =>
          r.kind === 'OUTCOME' && r.state === 'WAITING_FOR_PROVIDER' && r.consumption === 'NONE',
      ),
    ).toBe(true)
    await page.getByText('Provider routing and outcome', { exact: true }).click()
    await expect(page.getByText('No admitted provider', { exact: false }).first()).toBeVisible()
    expect(
      (
        await invoke(page, 'director.routing', {
          projectId: project.id,
          operationId: invocation.id,
        })
      ).every((r) => r.action === 'WAIT' && r.consumption === 'NOT_SENT'),
    ).toBe(true)
    await page.screenshot({ path: 'test-results/v72-director-escalation-routing.png' })
    await page.getByRole('button', { name: 'Save escalation', exact: true }).click()
    await page.getByText('Escalation · REQUESTED', { exact: true }).click()
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(page.getByText('Escalation · DISMISSED', { exact: true })).toBeVisible()
    expect((await invoke(page, 'director.history', { projectId: project.id })).length).toBe(1)
  } finally {
    await closeApp(app)
    removeDir(dataDir)
    removeDir(repo)
  }
})
