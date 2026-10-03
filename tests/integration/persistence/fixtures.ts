import { emptyMetrics } from '@shared/domain'
import type { Agent, Project, Run, RunConfig, Task } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import { DEFAULT_SETTINGS, buildRunConfig } from '@shared/settings'
import { openDatabase, createRepositories, type Database, type Repositories } from '@main/modules/persistence'

export function openMemory(): { db: Database; repos: Repositories } {
  const db = openDatabase(':memory:')
  return { db, repos: createRepositories(db) }
}

export const runConfig = (): RunConfig =>
  buildRunConfig(
    DEFAULT_SETTINGS,
    'balanced',
    { build: 'pnpm build', test: 'pnpm test', lint: null, typecheck: 'pnpm typecheck' },
    false,
  )

export function makeProject(over: Partial<Project> = {}): Project {
  const now = nowIso()
  return {
    id: newId(),
    name: 'Nexus',
    rootPath: 'C:\\Users\\user\\Documents\\Nexus',
    profile: {
      repoRoot: 'C:\\Users\\user\\Documents\\Nexus',
      isGitRepo: true,
      currentBranch: 'main',
      headCommit: 'ae35e3f',
      dirty: false,
      packageManagers: ['pnpm'],
      languages: ['TypeScript'],
      frameworks: ['Electron', 'React'],
      scripts: { test: 'vitest run' },
      commands: { build: 'pnpm build', test: 'pnpm test', lint: null, typecheck: 'pnpm typecheck' },
      docs: ['docs\\ARCHITECTURE.md'],
      hasClaudeMd: false,
      fileCount: 120,
      sizeBytes: 1_048_576,
      generatedPaths: ['out'],
      profiledAt: now,
    },
    respectProjectClaudeConfig: false,
    createdAt: now,
    lastOpenedAt: now,
    ...over,
  }
}

export function makeRun(projectId: string, over: Partial<Run> = {}): Run {
  return {
    id: newId(),
    projectId,
    mode: 'build',
    preset: 'balanced',
    state: 'planning',
    resumeState: null,
    pauseReason: null,
    prompt: 'Add a settings page',
    plan: null,
    baseBranch: 'main',
    baseCommit: 'ae35e3f',
    integrationBranch: null,
    config: runConfig(),
    error: null,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

export function makeTask(runId: string, key: string, over: Partial<Task> = {}): Task {
  return {
    id: newId(),
    runId,
    key,
    title: `Task ${key}`,
    description: `Implement ${key}`,
    role: 'worker',
    kind: 'implement',
    state: 'draft',
    priority: 0,
    complexity: 'medium',
    risk: 'low',
    parallelizable: true,
    requiresApproval: false,
    approvalGranted: false,
    suggestedFiles: ['src\\main\\a.ts', 'src/main/b.ts'],
    acceptanceCriteria: ['it works', 'tests pass'],
    attempt: 0,
    repairCycles: 0,
    parentTaskId: null,
    modelTierOverride: null,
    branch: null,
    worktreeId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    resultSummary: null,
    blockedReason: null,
    error: null,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

export function makeAgent(runId: string, taskId: string | null, over: Partial<Agent> = {}): Agent {
  return {
    id: newId(),
    runId,
    taskId,
    role: 'worker',
    purpose: 'implement',
    label: 'Worker/api',
    state: 'idle',
    model: 'claude-sonnet',
    activity: null,
    metrics: emptyMetrics(),
    error: null,
    createdAt: nowIso(),
    startedAt: null,
    stoppedAt: null,
    ...over,
  }
}

/** A project + run + two tasks + one agent, the usual starting point. */
export function seed(repos: Repositories) {
  const project = repos.projects.insert(makeProject())
  const run = repos.runs.insert(makeRun(project.id))
  const t1 = repos.tasks.insert(makeTask(run.id, 'api'))
  const t2 = repos.tasks.insert(makeTask(run.id, 'ui'))
  const agent = repos.agents.insert(makeAgent(run.id, t1.id))
  return { project, run, t1, t2, agent }
}
