import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, createRepo, git, invoke, launchApp, removeDir, screenshot, tempDir } from './helpers'

test('Programs and Workspace roots require canonical admission; a queued stale Program cannot start', async () => {
  const repo = createRepo(), dataDir = tempDir('workload-admission-v72')
  const { app, page } = await launchApp(dataDir, repo)
  try {
    await page.getByTestId('nav-projects').click()
    await page.getByTestId('open-project').click()
    await expect(page.getByTestId('project-detail')).toBeVisible()
    const projectId = (await invoke(page, 'projects.list', {}))[0]!.id
    const goal = '  Display leaderboard scores\n'
    const input = { projectId, name: 'Scores', goal, constraints: ['Keep <T> unchanged'], preset: 'balanced' }
    await expect(invoke(page, 'program.create', input)).rejects.toThrow('waiting')
    expect((await invoke(page, 'program.list', {})).programs).toHaveLength(0)
    const program = await invoke(page, 'program.create', { ...input, compilationMode: 'LIGHT' })
    const root = await invoke(page, 'compilation.admission', { kind: 'PROGRAM', entityId: program.id })
    expect(root).toMatchObject({ rawIntent: goal, status: 'READY', userMetadata: { constraints: ['Keep <T> unchanged'] } })
    expect(root?.intentId).toBeTruthy()
    writeFileSync(join(repo, 'other.txt'), 'Unrelated checkout change\n')
    git(repo, 'add', 'other.txt'); git(repo, 'commit', '-m', 'Advance checkout')
    await expect(invoke(page, 'program.start', { programId: program.id })).rejects.toThrow('stale')
    expect((await invoke(page, 'program.get', { programId: program.id })).program.state).toBe('DRAFT')
    const queued = await invoke(page, 'control.enqueue', { item: { type: 'program', programId: program.id } })
    await expect.poll(async () => (await invoke(page, 'control.overview', {})).finished.find(i => i.id === queued.id)?.state).toBe('FAILED')
    expect((await invoke(page, 'control.overview', {})).finished.find(i => i.id === queued.id)?.detail).toContain('stale')
    const ws = await invoke(page, 'workspace.create', { name: 'Scores workspace' })
    await invoke(page, 'workspace.enroll', { workspaceId: ws.id, path: repo, key: 'scores', role: 'application' })
    await expect(invoke(page, 'workspace.createMission', { workspaceId: ws.id, goal })).rejects.toThrow('waiting')
    await expect(invoke(page, 'workspace.createProgram', { workspaceId: ws.id, program: { name: 'Scores', goal, milestones: [{ title: 'Display', goal: 'Display scores' }] } })).rejects.toThrow('waiting')
    const mission = await invoke(page, 'workspace.createMission', { workspaceId: ws.id, goal, compilationMode: 'EXACT' })
    const workspaceProgram = await invoke(page, 'workspace.createProgram', { workspaceId: ws.id, program: { name: 'Scores', goal, milestones: [{ title: 'Display', goal: 'Display scores' }] }, compilationMode: 'EXACT' })
    for (const [kind, entityId] of [['WORKSPACE_MISSION', mission.id], ['WORKSPACE_PROGRAM', workspaceProgram.id]] as const) {
      const admitted = await invoke(page, 'compilation.admission', { kind, entityId })
      expect(admitted?.rawIntent).toBe(goal)
      expect(admitted?.dependencies.some(r => r.id === `workspace:${ws.id}`)).toBe(true)
      expect(admitted?.intentId).toBeTruthy()
    }
    const history = await invoke(page, 'compilation.history', { projectId })
    expect(new Set(history.map(s => s.userMetadata?.entryPoint))).toEqual(new Set(['PROGRAM', 'WORKSPACE_MISSION', 'WORKSPACE_PROGRAM']))
    await page.getByTestId('nav-programs').click()
    await page.getByText('Scores', { exact: true }).first().click()
    await page.getByTestId('admission-inspector').locator('summary').first().click()
    await expect(page.getByTestId('saved-specification')).toContainText('Keep <T> unchanged')
    await screenshot(page, 'v72-program-canonical-inspector')
  } finally { await closeApp(app); removeDir(dataDir); removeDir(repo) }
})

test('Task additions, instructions, criterion changes and Mission replans preserve admitted user text', async () => {
  const repo = createRepo(), dataDir = tempDir('amendment-admission-v72')
  const { app, page } = await launchApp(dataDir, repo)
  try {
    await page.getByTestId('nav-projects').click()
    await page.getByTestId('open-project').click()
    await expect(page.getByTestId('project-detail')).toBeVisible()
    const projectId = (await invoke(page, 'projects.list', {}))[0]!.id
    const run = await invoke(page, 'runs.create', { projectId, mode: 'mission', preset: 'balanced', prompt: 'Display leaderboard', compilationMode: 'EXACT', requirePlanApproval: true })
    await expect.poll(async () => (await invoke(page, 'runs.get', { runId: run.id })).run.state).toBe('awaiting_approval')
    const input = { runId: run.id, title: 'Extra score', description: '  Preserve <T> and x < 10\n', role: 'worker', complexity: 'small', dependsOn: [], suggestedFiles: [], acceptanceCriteria: ['Scores appear'] }
    await expect(invoke(page, 'tasks.add', input)).rejects.toThrow('waiting')
    const task = await invoke(page, 'tasks.add', { ...input, compilationMode: 'EXACT' })
    expect(task.description).toBe(input.description)
    await expect(invoke(page, 'tasks.instruct', { taskId: task.id, instruction: 'No extra dependencies' })).rejects.toThrow('waiting')
    for (const instruction of ['  Keep the public interface\n', 'No extra dependencies']) {
      const message = await invoke(page, 'tasks.instruct', { taskId: task.id, instruction, compilationMode: 'EXACT' })
      expect(message.body).toBe(instruction)
    }
    const criterion = (await invoke(page, 'runs.get', { runId: run.id })).criteria.find(c => c.taskId === task.id)!
    await expect(invoke(page, 'criteria.update', { criterionId: criterion.id, text: '  Scores remain visible\n' })).rejects.toThrow('waiting')
    const edited = await invoke(page, 'criteria.update', { criterionId: criterion.id, text: '  Scores remain visible\n', compilationMode: 'EXACT' })
    expect(edited.text).toBe('  Scores remain visible\n')
    const feedback = '  Keep both steps small\n'
    await expect(invoke(page, 'runs.replan', { runId: run.id, feedback })).rejects.toThrow('waiting')
    expect((await invoke(page, 'runs.get', { runId: run.id })).run.state).toBe('awaiting_approval')
    await invoke(page, 'runs.replan', { runId: run.id, feedback, compilationMode: 'EXACT' })
    const history = await invoke(page, 'compilation.history', { projectId })
    expect(history.filter(s => s.status === 'READY').map(s => s.userMetadata?.entryPoint)).toEqual(expect.arrayContaining(['MISSION', 'TASK_ADDITION', 'TASK_INSTRUCTION', 'CRITERION_UPDATE', 'MISSION_REPLAN']))
    expect(history.some(s => s.rawIntent === feedback && s.intentId && s.status === 'READY')).toBe(true)
  } finally { await closeApp(app); removeDir(dataDir); removeDir(repo) }
})
