import { describe, expect, it } from 'vitest'
import type {
  CommandResult,
  Decision,
  Handoff,
  MemoryEntry,
  Message,
  ProjectProfile,
  Run,
  RunMode,
  Task,
} from '@shared/domain'
import {
  HandoffSchema,
  MissionPlanSchema,
  RUN_MODES,
  ReviewOutputSchema,
  VerifierOutputSchema,
} from '@shared/domain'
import {
  SECTION_LIMITS,
  buildAuditSynthesisPrompt,
  buildContextPack,
  buildHandoffRequestPrompt,
  buildMissionVerifierPrompt,
  buildPlannerPrompt,
  buildRepairPrompt,
  buildResumeFromHandoffPrompt,
  buildReviewPrompt,
  buildVerifierPrompt,
  handoffJsonSchema,
  missionPlanJsonSchema,
  reviewOutputJsonSchema,
  verifierOutputJsonSchema,
} from '@main/modules/context/context-builder'
import type { ContextPackInput } from '@main/modules/context/context-builder'

const checks = { build: 'pnpm run build', test: 'pnpm test', lint: null, typecheck: 'pnpm run typecheck' }

function makeRun(mode: RunMode = 'build'): Run {
  return {
    id: 'run-1',
    projectId: 'p1',
    mode,
    preset: 'balanced',
    state: 'planning',
    resumeState: null,
    pauseReason: null,
    prompt: 'Add a dark mode toggle',
    plan: null,
    baseBranch: 'main',
    baseCommit: 'abc123',
    integrationBranch: 'nexus/run-1',
    config: {
      maxParallelAgents: 4,
      maxTurnsPerAgent: 50,
      maxRetriesPerTask: 2,
      maxDurationMinutes: 60,
      maxIterations: 3,
      requirePlanApproval: true,
      modelPolicy: {
        planner: 'strongest',
        architect: 'strongest',
        worker: 'balanced',
        debugger: 'balanced',
        reviewer: 'strongest',
        verifier: 'strongest',
        researcher: 'fast',
        security_reviewer: 'strongest',
      },
      checks,
      respectProjectClaudeConfig: false,
      subscriptionMode: true,
      sessionRotationTurns: 0,
      leaseMinutes: 10,
      enabledMcpServers: [],
    },
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  }
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    runId: 'run-1',
    key: 'toggle-ui',
    title: 'Build toggle',
    description: 'Create the toggle component.',
    role: 'worker',
    kind: 'implement',
    state: 'running',
    priority: 0,
    complexity: 'small',
    risk: 'low',
    parallelizable: true,
    requiresApproval: false,
    approvalGranted: false,
    suggestedFiles: ['src/Toggle.tsx'],
    acceptanceCriteria: ['Toggle flips the theme'],
    attempt: 1,
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
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

function baseInput(over: Partial<ContextPackInput> = {}): ContextPackInput {
  return {
    run: makeRun(),
    task: makeTask(),
    purpose: 'implement',
    missionCriteria: [],
    dependencyOutputs: [],
    decisions: [],
    memory: [],
    messages: [],
    repo: {
      worktreePath: 'C:\\work\\wt1',
      branch: 'nexus/run-1/toggle-ui',
      baseCommit: 'abc123',
      projectName: 'demo',
      checks,
    },
    ...over,
  }
}

const decision: Decision = {
  id: 'd1',
  runId: 'run-1',
  taskId: null,
  agentId: null,
  title: 'Use CSS variables',
  decision: 'Theme via CSS variables',
  rationale: 'No runtime cost',
  createdAt: '',
}
const memoryEntry: MemoryEntry = {
  id: 'm1',
  scope: 'project',
  projectId: 'p1',
  runId: null,
  taskId: null,
  agentId: null,
  kind: 'fact',
  title: 'Tests use vitest',
  content: 'Run vitest via pnpm test',
  tags: [],
  filePaths: ['vitest.config.ts'],
  source: 'user',
  evidence: null,
  status: 'approved',
  createdAt: '',
}
const message: Message = {
  id: 'msg1',
  runId: 'run-1',
  type: 'interface_change',
  severity: 'high',
  fromAgentId: null,
  fromTaskId: null,
  fromLabel: 'Worker/api',
  toTaskId: null,
  toRole: null,
  toLabel: 'Worker/ui',
  subject: 'Signature changed',
  body: 'getTheme() now returns a Promise',
  createdAt: '',
}

describe('buildContextPack', () => {
  it('includes only the task, repo state and task criteria when nothing else is given', () => {
    const pack = buildContextPack(baseInput())
    expect(pack.sections.map((s) => s.name)).toEqual([
      'Task',
      'Acceptance criteria',
      'Repository state',
    ])
    expect(pack.prompt).toContain('Build toggle')
    expect(pack.prompt).toContain('C:\\work\\wt1')
    expect(pack.prompt).toContain('lint: (none)')
    expect(pack.prompt).toContain('test: pnpm test')
  })

  describe('with an admitted specification', () => {
    const admitted = (prompt: string): Run => {
      const run = makeRun()
      const spec = { mode: 'EXACT', rawIntent: prompt, recommendations: [], ambiguities: [] } as unknown as NonNullable<Run['config']['compiledTaskSpec']>
      return { ...run, prompt, config: { ...run.config, compiledTaskSpec: spec } }
    }
    const copies = (text: string, part: string): number => text.split(part).length - 1

    it('shows a worker the request once, whole when it fits', () => {
      const request = `Add a dark mode toggle. ${'Keep the header layout. '.repeat(80)}`
      const pack = buildContextPack(baseInput({ run: admitted(request) }))
      expect(copies(pack.prompt, request)).toBe(1)
      // What the specification adds to a pack is the request and its heading, nothing else.
      const plain = buildContextPack(baseInput())
      expect(pack.prompt.length - plain.prompt.length).toBeLessThan(request.length + 200)
    })

    it('keeps a long request within the limit of a section, and says so', () => {
      const request = `${'A requirement of the user. '.repeat(800)}THE-END`
      expect(request.length).toBeGreaterThan(20_000)
      const pack = buildContextPack(baseInput({ run: admitted(request) }))
      const plain = buildContextPack(baseInput())
      expect(pack.prompt.length - plain.prompt.length).toBeLessThan(SECTION_LIMITS.task + 500)
      expect(pack.prompt).not.toContain('THE-END')
      expect(pack.prompt).toMatch(/truncated: \d+ more characters omitted/)
      expect(pack.prompt).toContain('The planner read the whole request')
    })

    it('gives the planner the whole request, once', () => {
      const request = `${'A requirement of the user. '.repeat(800)}THE-END`
      const { prompt } = buildPlannerPrompt({ run: admitted(request), profile, memory: [] })
      expect(copies(prompt, 'THE-END')).toBe(1)
    })
  })

  it('omits the criteria section when there are none', () => {
    const pack = buildContextPack(baseInput({ task: makeTask({ acceptanceCriteria: [] }) }))
    expect(pack.sections.map((s) => s.name)).not.toContain('Acceptance criteria')
  })

  it('renders every optional section when provided', () => {
    const handoff: Handoff = {
      completedWork: ['wrote component'],
      commits: ['deadbeef'],
      filesChanged: ['src/Toggle.tsx'],
      unresolvedIssues: [],
      importantFindings: [],
      nextSteps: ['add tests'],
    }
    const pack = buildContextPack(
      baseInput({
        missionCriteria: ['Dark mode works'],
        dependencyOutputs: [{ key: 'api', title: 'API', summary: 'Added /theme endpoint' }],
        decisions: [decision],
        memory: [memoryEntry],
        messages: [message],
        extra: {
          handoff,
          attempt: 3,
          failure: { kind: 'checks', summary: 'tests failed', details: 'expected 1 got 2' },
          userInstructions: ['Keep it small'],
        },
      }),
    )
    expect(pack.sections.map((s) => s.name)).toEqual([
      'Task',
      'Acceptance criteria',
      'Results of dependency tasks',
      'Relevant decisions',
      'Project memory',
      'Messages from other agents',
      'Repository state',
      'Attempt',
      'Failure to address',
      'Handoff from previous session',
      'User instructions',
    ])
    expect(pack.prompt).toContain('Added /theme endpoint')
    expect(pack.prompt).toContain('Theme via CSS variables')
    expect(pack.prompt).toContain('[files: vitest.config.ts]')
    expect(pack.prompt).toContain('interface_change/high')
    expect(pack.prompt).toContain('Attempt 3.')
    expect(pack.prompt).toContain('expected 1 got 2')
    expect(pack.prompt).toContain('add tests')
    expect(pack.prompt).toContain('Keep it small')
  })

  it('does not mention attempt 1 and omits an empty handoff', () => {
    const empty: Handoff = {
      completedWork: [],
      commits: [],
      filesChanged: [],
      unresolvedIssues: [],
      importantFindings: [],
      nextSteps: [],
    }
    const pack = buildContextPack(baseInput({ extra: { attempt: 1, handoff: empty } }))
    expect(pack.sections.map((s) => s.name)).not.toContain('Attempt')
    expect(pack.sections.map((s) => s.name)).not.toContain('Handoff from previous session')
  })

  it('truncates oversized sections with an explicit marker', () => {
    const big = 'x'.repeat(SECTION_LIMITS.taskDescription * 2)
    const pack = buildContextPack(baseInput({ task: makeTask({ description: big }) }))
    const task = pack.sections.find((s) => s.name === 'Task')
    expect(task).toBeDefined()
    expect(pack.prompt).toMatch(/\[\.\.\. truncated: \d+ more characters omitted \.\.\.\]/)
    expect(task?.chars ?? Infinity).toBeLessThan(SECTION_LIMITS.taskDescription + 300)
  })

  it('bounds dependency outputs and reports omitted entries', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      key: `k${i}`,
      title: `T${i}`,
      summary: 'y'.repeat(2000),
    }))
    const pack = buildContextPack(baseInput({ dependencyOutputs: many }))
    const dep = pack.sections.find((s) => s.name === 'Results of dependency tasks')
    expect(dep?.chars ?? Infinity).toBeLessThan(SECTION_LIMITS.dependencies + 2500)
    expect(pack.prompt).toMatch(/\[\.\.\. \d+ more dependency outputs omitted \.\.\.\]/)
  })

  it('reports section sizes matching rendered bodies', () => {
    const pack = buildContextPack(baseInput({ decisions: [decision] }))
    for (const s of pack.sections) expect(s.chars).toBeGreaterThan(0)
    const total = pack.sections.reduce((n, s) => n + s.chars, 0)
    expect(pack.prompt.length).toBeGreaterThanOrEqual(total)
  })
})

const profile: ProjectProfile = {
  repoRoot: 'C:\\repo',
  isGitRepo: true,
  currentBranch: 'main',
  headCommit: 'abc',
  dirty: false,
  packageManagers: ['pnpm'],
  languages: ['TypeScript'],
  frameworks: ['react'],
  scripts: { test: 'vitest', build: 'vite build' },
  commands: checks,
  docs: ['README.md'],
  hasClaudeMd: true,
  fileCount: 120,
  sizeBytes: 5000,
  generatedPaths: ['node_modules'],
  profiledAt: '',
}

describe('buildPlannerPrompt', () => {
  const marker: Record<RunMode, RegExp> = {
    ask: /Mode ASK/,
    build: /Mode BUILD/,
    swarm: /maximum useful safe parallel decomposition/,
    repair: /reproduce -> diagnose -> fix -> regression test/,
    audit: /exactly one synthesis task[\s\S]*ALL review tasks/,
    mission: /multi-feature, long-running/,
    loop: /bounded iterations against explicit acceptance criteria/,
  }

  it.each(RUN_MODES)('is mode-aware for %s', (mode) => {
    const { prompt } = buildPlannerPrompt({ run: makeRun(mode), profile, memory: [] })
    expect(prompt).toMatch(marker[mode])
    expect(prompt).toContain('Add a dark mode toggle')
    expect(prompt).toContain('Maximum parallel agents: 4')
  })

  it('differs between modes', () => {
    const texts = new Set(
      RUN_MODES.map((m) => buildPlannerPrompt({ run: makeRun(m), profile, memory: [] }).prompt),
    )
    expect(texts.size).toBe(RUN_MODES.length)
  })

  it('includes a compact profile summary and memory, never file contents', () => {
    const { prompt, sections } = buildPlannerPrompt({ run: makeRun(), profile, memory: [memoryEntry] })
    expect(prompt).toContain('Languages: TypeScript')
    expect(prompt).toContain('Frameworks: react')
    expect(prompt).toContain('typecheck: pnpm run typecheck')
    expect(prompt).toContain('Tests use vitest')
    expect(sections.find((s) => s.name === 'Project profile')?.chars).toBeLessThan(
      SECTION_LIMITS.profile + 200,
    )
  })

  it('adds revision, errors and feedback only when provided', () => {
    const plain = buildPlannerPrompt({ run: makeRun(), profile, memory: [] })
    expect(plain.sections.map((s) => s.name)).toEqual([
      'Request',
      'Mode',
      'Limits',
      'Project profile',
      'Instructions',
    ])
    const plan = MissionPlanSchema.parse(samplePlan())
    const revised = buildPlannerPrompt({
      run: makeRun(),
      profile,
      memory: [],
      feedback: 'Split the UI task',
      previousErrors: ['cycle between a and b'],
      previousPlan: plan,
    })
    expect(revised.prompt).toContain('Split the UI task')
    expect(revised.prompt).toContain('cycle between a and b')
    expect(revised.prompt).toContain('"toggle-ui"')
  })
})

describe('buildReviewPrompt', () => {
  const failing: CommandResult = {
    name: 'test',
    command: 'pnpm test',
    cwd: 'C:\\wt',
    exitCode: 1,
    timedOut: false,
    durationMs: 10,
    output: 'FAIL toggle.test.ts',
  }

  it('contains requirements, criteria, diff and test output', () => {
    const { prompt } = buildReviewPrompt({
      task: makeTask(),
      missionCriteria: ['Dark mode works'],
      diffStat: ' src/Toggle.tsx | 10 ++',
      patch: '+const x = 1',
      checkResults: [failing],
      attempt: 2,
    })
    expect(prompt).toContain('Create the toggle component.')
    expect(prompt).toContain('Toggle flips the theme')
    expect(prompt).toContain('Dark mode works')
    expect(prompt).toContain('src/Toggle.tsx | 10')
    expect(prompt).toContain('+const x = 1')
    expect(prompt).toContain('FAILED (exit 1)')
    expect(prompt).toContain('FAIL toggle.test.ts')
    expect(prompt).toContain('Review attempt 2')
  })

  it('cannot carry worker reasoning: even a task with a result summary does not leak it', () => {
    const task = makeTask({ resultSummary: 'I reasoned that the toggle is perfect' })
    const { prompt } = buildReviewPrompt({
      task,
      missionCriteria: [],
      diffStat: '',
      patch: '+a',
      checkResults: [],
      attempt: 1,
    })
    expect(prompt).not.toContain('I reasoned')
  })

  it('truncates huge patches explicitly', () => {
    const { prompt } = buildReviewPrompt({
      task: makeTask(),
      missionCriteria: [],
      diffStat: '',
      patch: 'p'.repeat(SECTION_LIMITS.patch + 500),
      checkResults: [],
      attempt: 1,
    })
    expect(prompt).toContain('truncated: 500 more characters omitted')
  })
})

describe('other stage prompts', () => {
  it('verifier prompt includes the review summary when present', () => {
    const withReview = buildVerifierPrompt({
      task: makeTask(),
      missionCriteria: [],
      diffStat: 'x',
      checkResults: [],
      reviewSummary: 'Looks fine',
    })
    expect(withReview.prompt).toContain('Looks fine')
    const without = buildVerifierPrompt({
      task: makeTask(),
      missionCriteria: [],
      diffStat: 'x',
      checkResults: [],
    })
    expect(without.sections.map((s) => s.name)).not.toContain('Review summary')
  })

  it('repair prompt renders findings, failed criteria and check output', () => {
    const { prompt } = buildRepairPrompt({
      task: makeTask(),
      failure: { kind: 'review', summary: 'Review requested changes', details: '2 findings' },
      findings: [
        {
          title: 'Null deref',
          description: 'x can be null',
          evidence: 'Toggle.tsx:10',
          severity: 'high',
          category: 'correctness',
          file: 'src/Toggle.tsx',
          lineStart: 10,
          lineEnd: null,
          confidence: 'high',
          suggestedCorrection: 'guard x',
        },
      ],
      failures: [
        { criterion: 'Flips theme', evidence: 'no handler', likelyCause: 'missing onClick', relevantFiles: ['src/Toggle.tsx'] },
      ],
    })
    expect(prompt).toContain('did not pass review')
    expect(prompt).toContain('[high/correctness] Null deref (src/Toggle.tsx:10)')
    expect(prompt).toContain('Suggested correction: guard x')
    expect(prompt).toContain('Likely cause: missing onClick')
  })

  it('handoff request and resume prompts', () => {
    expect(buildHandoffRequestPrompt()).toContain('completedWork')
    const { prompt } = buildResumeFromHandoffPrompt({
      task: makeTask(),
      handoff: {
        completedWork: ['half done'],
        commits: [],
        filesChanged: [],
        unresolvedIssues: [],
        importantFindings: [],
        nextSteps: ['finish'],
      },
      worktreePath: 'C:\\wt',
      branch: 'b',
    })
    expect(prompt).toContain('half done')
    expect(prompt).toContain('Verify the current state')
  })

  it('mission verifier and audit synthesis prompts', () => {
    const mv = buildMissionVerifierPrompt({
      run: makeRun('mission'),
      missionCriteria: ['All features work'],
      diffStat: 'stat',
      checkResults: [],
    })
    expect(mv.prompt).toContain('nexus/run-1')
    expect(mv.prompt).toContain('All features work')
    const as = buildAuditSynthesisPrompt({
      run: makeRun('audit'),
      auditOutputs: [{ key: 'sec', title: 'Security', summary: 'found XSS' }],
      missionCriteria: [],
    })
    expect(as.prompt).toContain('found XSS')
    expect(as.prompt).toContain('read-only')
  })
})

function samplePlan(): unknown {
  return {
    summary: 'Add toggle',
    assumptions: [],
    acceptanceCriteria: ['Toggle works'],
    tasks: [
      {
        id: 'toggle-ui',
        title: 'UI',
        description: 'Build it',
        role: 'worker',
        dependencies: [],
        parallelizable: true,
        suggestedFiles: ['src/Toggle.tsx'],
        acceptanceCriteria: ['renders'],
        complexity: 'small',
        risk: 'low',
        requiresApproval: false,
      },
    ],
    risks: [{ description: 'flash of wrong theme', mitigation: 'inline script' }],
  }
}

describe('JSON schema export', () => {
  const schemas = {
    missionPlan: missionPlanJsonSchema,
    reviewOutput: reviewOutputJsonSchema,
    verifierOutput: verifierOutputJsonSchema,
    handoff: handoffJsonSchema,
  }

  it.each(Object.entries(schemas))('%s is a plain object schema without $ref', (_name, schema) => {
    expect(schema['type']).toBe('object')
    expect(typeof schema['properties']).toBe('object')
    const text = JSON.stringify(schema)
    expect(text).not.toContain('$ref')
    expect(text).not.toContain('$defs')
    expect(String(schema['$schema'])).toContain('draft-07')
    // Round-trips as plain JSON.
    expect(JSON.parse(text)).toEqual(schema)
  })

  it('mission plan schema requires the plan fields', () => {
    expect(missionPlanJsonSchema['required']).toEqual(
      expect.arrayContaining(['summary', 'assumptions', 'acceptanceCriteria', 'tasks', 'risks']),
    )
  })

  it('the zod schemas accept conforming samples', () => {
    expect(MissionPlanSchema.safeParse(samplePlan()).success).toBe(true)
    expect(
      ReviewOutputSchema.safeParse({
        summary: 'ok',
        findings: [
          {
            title: 't',
            description: 'd',
            evidence: 'e',
            severity: 'low',
            category: 'correctness',
            file: null,
            lineStart: null,
            lineEnd: null,
            confidence: 'medium',
            suggestedCorrection: null,
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      VerifierOutputSchema.safeParse({
        summary: 's',
        criteria: [{ criterion: 'c', passed: true, evidence: 'e' }],
        failures: [],
      }).success,
    ).toBe(true)
    expect(
      HandoffSchema.safeParse({
        completedWork: [],
        commits: [],
        filesChanged: [],
        unresolvedIssues: [],
        importantFindings: [],
        nextSteps: [],
      }).success,
    ).toBe(true)
  })
})
