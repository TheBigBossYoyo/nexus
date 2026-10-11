import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { CrossRepoTask, WorkspaceMission } from '../../src/shared/workspace'
import { closeApp, git, invoke, launchApp, removeDir, screenshot, tempDir, selectExactCompilation } from './helpers'

/**
 * NEXUS 0.5 against the built app with the scripted runtime: a workspace of three repositories with a shared
 * contract, a cross-repository mission from the dialog to global verification and a prepared release train, and
 * a breaking change that leaves the consumers behind. No real Claude session is used.
 */
const ORDER = `${JSON.stringify({ title: 'Order', type: 'object', required: ['id'], properties: { id: { type: 'string' }, total: { type: 'number' } } }, null, 2)}\n`

function repository(name: string, files: Record<string, string>): string {
  const root = tempDir(name)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'E2E Tester')
  git(root, 'config', 'user.email', 'e2e@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  for (const [path, content] of Object.entries({
    'package.json': `${JSON.stringify({ name, version: '1.0.0', scripts: { test: 'node --version' } }, null, 2)}\n`,
    'README.md': `# ${name}\n`,
    ...files,
  })) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'Initial commit')
  return root
}

interface Fixture {
  sdk: string
  backend: string
  desktop: string
}

function fixture(): Fixture {
  return {
    sdk: repository('shared-sdk', { 'contracts/order.schema.json': ORDER }),
    backend: repository('backend', {
      'contracts/order.schema.json': ORDER,
      'src/api.js': 'export const api = 0\n',
    }),
    desktop: repository('desktop', {
      'vendor/order.schema.json': ORDER,
      'src/ui.js': 'export const ui = 0\n',
    }),
  }
}

/** Creates the workspace in the UI, enrolls the first repository through the folder picker and the others by path. */
async function buildWorkspace(page: Page, f: Fixture): Promise<string> {
  await page.getByTestId('nav-workspaces').click()
  await page.getByTestId('workspaces-new').click()
  const dialog = page.getByTestId('workspace-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('workspace-name').fill('Orders')
  await dialog.getByTestId('workspace-create').click()
  await expect(page.getByTestId('workspace-tab-overview')).toBeVisible({ timeout: 30_000 })
  const workspaceId = (await invoke(page, 'workspace.list', {}))[0]?.workspace.id ?? ''
  expect(workspaceId).not.toBe('')

  // The folder picker of the test returns the provider's path.
  await page.getByTestId('workspace-enroll').first().click()
  await expect
    .poll(async () => (await invoke(page, 'workspace.get', { workspaceId })).repositories.length, {
      timeout: 30_000,
    })
    .toBe(1)
  const provider = (await invoke(page, 'workspace.get', { workspaceId })).repositories[0]?.key ?? ''
  expect(provider).not.toBe('')
  await invoke(page, 'workspace.enroll', {
    workspaceId,
    path: f.backend,
    key: 'backend',
    role: 'service',
  })
  await invoke(page, 'workspace.enroll', {
    workspaceId,
    path: f.desktop,
    key: 'desktop',
    role: 'application',
  })

  await invoke(page, 'workspace.addDependency', {
    workspaceId,
    from: 'backend',
    to: provider,
    kind: 'schema',
    detail: 'backend validates orders with the shared schema',
  })
  await invoke(page, 'workspace.addDependency', {
    workspaceId,
    from: 'desktop',
    to: 'backend',
    kind: 'api_provider_consumer',
    detail: 'desktop calls the backend API',
  })
  const contract = await invoke(page, 'workspace.registerContract', {
    workspaceId,
    key: 'order',
    name: 'Order',
    kind: 'json_schema',
    provider,
    path: 'contracts/order.schema.json',
  })
  await invoke(page, 'workspace.addConsumer', {
    contractId: contract.id,
    repository: 'backend',
    copyPath: 'contracts/order.schema.json',
  })
  await invoke(page, 'workspace.addConsumer', {
    contractId: contract.id,
    repository: 'desktop',
    copyPath: 'vendor/order.schema.json',
  })
  await invoke(page, 'workspace.captureContract', { contractId: contract.id })
  return workspaceId
}

async function waitForMission(
  page: Page,
  missionId: string,
  states: WorkspaceMission['state'][],
  timeout = 300_000,
): Promise<{ mission: WorkspaceMission; tasks: CrossRepoTask[] }> {
  let last: { mission: WorkspaceMission; tasks: CrossRepoTask[] } | null = null
  await expect
    .poll(
      async () => {
        last = await invoke(page, 'workspace.mission', { missionId })
        return states.includes(last.mission.state)
      },
      {
        timeout,
        intervals: [1000],
        message: `the workspace mission to be one of ${states.join(', ')}`,
      },
    )
    .toBe(true)
  if (!last) throw new Error('No mission')
  return last
}

async function startMissionFromDialog(
  page: Page,
  workspaceId: string,
  goal: string,
): Promise<string> {
  await page.getByTestId('workspace-tab-missions').click()
  await page.getByTestId('workspace-mission-new').click()
  await page.getByTestId('workspace-mission-goal').fill(goal)
  await selectExactCompilation(page)
  await page.getByTestId('workspace-mission-start').click()
  await expect(page.getByTestId('mission-detail')).toBeVisible({ timeout: 30_000 })
  const missions = (await invoke(page, 'workspace.get', { workspaceId })).missions
  const mission = missions.find((m) => m.goal === goal)
  if (!mission) throw new Error('The mission was not created')
  return mission.id
}

test.describe('NEXUS 0.5 workspaces', () => {
  const dirs: string[] = []
  test.afterAll(() => {
    for (const d of dirs) removeDir(d)
  })

  test('a cross-repository mission from the dialog to global verification and a prepared release train', async () => {
    test.setTimeout(480_000)
    const f = fixture()
    const dataDir = tempDir('data')
    dirs.push(f.sdk, f.backend, f.desktop, dataDir)
    const heads = {
      sdk: git(f.sdk, 'rev-parse', 'HEAD'),
      backend: git(f.backend, 'rev-parse', 'HEAD'),
      desktop: git(f.desktop, 'rev-parse', 'HEAD'),
    }
    const { app, page } = await launchApp(dataDir, f.sdk)
    try {
      await page.getByTestId('nav-workspaces').click()
      await screenshot(page, 'v5-workspaces-empty')
      const workspaceId = await buildWorkspace(page, f)

      await page.getByTestId('workspace-tab-graph').click()
      await expect(page.getByTestId('graph-node-backend')).toBeVisible()
      await expect(page.getByTestId('graph-node-desktop')).toBeVisible()
      await screenshot(page, 'v5-workspace-graph')
      await page.getByTestId('workspace-tab-contracts').click()
      await expect(page.getByTestId('contract-capture-order')).toBeVisible()
      await screenshot(page, 'v5-workspace-contracts')

      const missionId = await startMissionFromDialog(
        page,
        workspaceId,
        'Add a field to the order contract and bring every consumer in step.',
      )
      // The plan is held for approval: one task per repository, the provider first.
      const planned = await waitForMission(page, missionId, ['AWAITING_APPROVAL', 'BLOCKED'])
      expect(planned.mission.state, planned.mission.blockedReason ?? '').toBe('AWAITING_APPROVAL')
      await expect(page.getByTestId('mission-plan-approval')).toBeVisible({ timeout: 15_000 })
      await screenshot(page, 'v5-mission-plan')
      await page.getByTestId('mission-plan-accept').click()

      const done = await waitForMission(
        page,
        missionId,
        ['COMPLETED', 'BLOCKED', 'FAILED'],
        400_000,
      )
      expect(done.mission.state, done.mission.blockedReason ?? '').toBe('COMPLETED')
      expect(done.tasks.map((t) => [t.repository, t.state])).toEqual([
        [expect.any(String), 'COMPLETED'],
        ['backend', 'COMPLETED'],
        ['desktop', 'COMPLETED'],
      ])
      expect(done.mission.verification).toMatchObject({ passed: true })
      const order = done.mission.verification?.contracts.find((c) => c.contract === 'order')
      expect(order?.result.level).toBe('compatible')
      expect(order?.consumersInSync.map((c) => [c.repository, c.inSync])).toEqual([
        ['backend', true],
        ['desktop', true],
      ])
      await expect(page.getByTestId('mission-detail')).toHaveAttribute('data-state', 'COMPLETED', {
        timeout: 15_000,
      })
      await expect(page.getByTestId('mission-verification')).toHaveAttribute('data-passed', 'true')
      await expect(page.getByTestId('mission-tasks')).toBeVisible()
      await screenshot(page, 'v5-mission-completed')

      // Every result is on a NEXUS branch; the user's checkouts are exactly as they were.
      for (const [name, path] of Object.entries(f)) {
        expect(git(path, 'rev-parse', 'HEAD'), name).toBe(heads[name as keyof Fixture])
        expect(git(path, 'status', '--porcelain'), name).toBe('')
        expect(git(path, 'branch', '--show-current'), name).toBe('main')
      }
      expect(readFileSync(join(f.sdk, 'contracts/order.schema.json'), 'utf8')).toBe(ORDER)
      const backendTask = done.tasks.find((t) => t.repository === 'backend')
      const sdkTask = done.tasks[0]
      const provided = git(
        f.sdk,
        'show',
        `${sdkTask?.resultCommit ?? ''}:contracts/order.schema.json`,
      )
      expect(provided).toContain('addedField')
      expect(
        git(
          f.backend,
          'show',
          `${backendTask?.resultCommit ?? ''}:contracts/order.schema.json`,
        ).trim(),
      ).toBe(provided.trim())

      // A release train was prepared, never published; publishing is refused outright.
      const detail = await invoke(page, 'workspace.get', { workspaceId })
      const train = detail.releaseTrains.find((t) => t.missionId === missionId)
      expect(train).toMatchObject({ state: 'PREPARED' })
      expect(train?.plan.steps.map((s) => s.repository)).toEqual([
        sdkTask?.repository,
        'backend',
        'desktop',
      ])
      const refused = await page.evaluate(
        async (trainId) =>
          (
            globalThis as unknown as {
              nexus: { invoke(c: string, i: object): Promise<{ ok: boolean }> }
            }
          ).nexus.invoke('workspace.publishRelease', { trainId }),
        train?.id ?? '',
      )
      expect(refused.ok).toBe(false)
      await page.getByTestId('workspace-tab-releases').click()
      await expect(page.getByTestId('release-statement').first()).toBeVisible()
      await screenshot(page, 'v5-release-train')
      // The planner session is internal: the Missions list shows the three task missions only.
      const runs = await invoke(page, 'runs.list', {})
      expect(runs.filter((r) => r.mode === 'ask')).toEqual([])
    } finally {
      await closeApp(app)
    }
  })

  test('a breaking change that leaves the consumers behind fails global verification and blocks the mission', async () => {
    test.setTimeout(480_000)
    const f = fixture()
    const dataDir = tempDir('data')
    dirs.push(f.sdk, f.backend, f.desktop, dataDir)
    const { app, page } = await launchApp(dataDir, f.sdk)
    try {
      const workspaceId = await buildWorkspace(page, f)
      const missionId = await startMissionFromDialog(
        page,
        workspaceId,
        'Rename a field of the order contract. [demo:breaking] [demo:skip-consumer]',
      )
      await waitForMission(page, missionId, ['AWAITING_APPROVAL'])
      await page.getByTestId('mission-plan-accept').click()
      const ended = await waitForMission(
        page,
        missionId,
        ['COMPLETED', 'BLOCKED', 'FAILED'],
        400_000,
      )
      expect(ended.mission.state, JSON.stringify({ v: ended.mission.verification, t: ended.tasks.map((t) => [t.key, t.contracts, t.summary]) })).toBe('BLOCKED')
      expect(ended.mission.blockedReason ?? '').toContain('Global verification failed')
      expect(ended.mission.verification).toMatchObject({ passed: false })
      expect(
        ended.mission.verification?.contracts.find((c) => c.contract === 'order')?.result.level,
      ).toBe('breaking')
      await expect(page.getByTestId('mission-detail')).toHaveAttribute('data-state', 'BLOCKED', {
        timeout: 15_000,
      })
      await expect(page.getByTestId('mission-verification')).toHaveAttribute('data-passed', 'false')
      await screenshot(page, 'v5-mission-blocked')
      // Unverified work records no contract version and prepares no release.
      const detail = await invoke(page, 'workspace.get', { workspaceId })
      expect(detail.releaseTrains).toEqual([])
      expect(
        detail.contracts.find((c) => c.key === 'order')?.versions.map((v) => v.version),
      ).toEqual([1])
    } finally {
      await closeApp(app)
    }
  })
})
