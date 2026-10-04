import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { MissionPlan } from '@shared/domain'
import { completeWith, scriptsByRole, specPurpose, type FakeScript } from './fake-runtime'

/**
 * Scripted agents for UI end-to-end tests (`NEXUS_FAKE_RUNTIME=1`, unpackaged builds only).
 * No Claude usage. The first review of task `ui` requests changes so the repair loop is exercised.
 *
 * A marker in the mission text selects how the mission goes, so UI tests can reach every way an
 * overnight run ends: `[demo:stall]` (workers never finish), `[demo:quota]` (a worker hits a usage
 * limit that reports no reset time), `[demo:fail]` (the planner never returns a valid plan).
 */
export function createDemoScript(): FakeScript {
  const plan: MissionPlan = {
    summary: 'Add an API module and a UI module, then integrate them.',
    assumptions: ['The repository is a scratch project.'],
    acceptanceCriteria: ['api.txt, ui.txt and integration.txt exist on the integration branch'],
    risks: [{ description: 'Modules drift apart', mitigation: 'Integration task depends on both' }],
    tasks: [
      {
        id: 'api',
        title: 'Create the API module',
        description: 'Create api.txt describing the API.',
        role: 'worker',
        dependencies: [],
        parallelizable: true,
        suggestedFiles: ['api.txt'],
        acceptanceCriteria: ['api.txt exists'],
        complexity: 'small',
        risk: 'low',
        requiresApproval: false,
      },
      {
        id: 'ui',
        title: 'Create the UI module',
        description: 'Create ui.txt describing the UI.',
        role: 'worker',
        dependencies: [],
        parallelizable: true,
        suggestedFiles: ['ui.txt'],
        acceptanceCriteria: ['ui.txt exists'],
        complexity: 'small',
        risk: 'low',
        requiresApproval: false,
      },
      {
        id: 'integration',
        title: 'Integrate API and UI',
        description: 'Create integration.txt referencing both modules.',
        role: 'worker',
        dependencies: ['api', 'ui'],
        parallelizable: true,
        suggestedFiles: ['integration.txt'],
        acceptanceCriteria: ['integration.txt exists'],
        complexity: 'small',
        risk: 'low',
        requiresApproval: false,
      },
    ],
  }

  let uiReviews = 0
  let docsProposed = false
  let behaviour: 'normal' | 'stall' | 'quota' | 'fail' = 'normal'
  let quotaHit = false

  const writer =
    (suffix: string): FakeScript =>
    async (spec, ctx) => {
      // A task whose key clashes with an existing branch (e.g. `integration`) gets a short id suffix on its directory.
      const key = basename(spec.cwd).replace(/-[0-9a-f]{8}$/, '')
      await ctx.emitText(`Working on ${key} in ${spec.cwd}`)
      if (behaviour === 'stall') {
        // Until the session is stopped (a pause, the mission deadline, or the app closing).
        await ctx.sleep(60 * 60_000)
        return
      }
      if (behaviour === 'quota' && !quotaHit) {
        quotaHit = true
        await ctx.rateLimit({ status: 'rejected', resetsAt: null, limitType: 'five_hour' })
        await ctx.completeTurn({ text: 'Usage limit reached.', outcome: 'quota' })
        return
      }
      await ctx.sleep(300)
      const target = join(spec.cwd, `${key}.txt`)
      await ctx.useTool('Write', { file_path: target, content: `${key}${suffix}` }, async () => {
        await writeFile(target, `${key}${suffix}\n`)
        return 'File written'
      })
      if (key === 'api' && ctx.nexusTools) {
        await ctx.nexusTools.sendMessage({
          type: 'interface_change',
          subject: 'API module created',
          body: 'api.txt now exists; the integration task can reference it.',
          toTask: 'integration',
          toRole: null,
          severity: null,
        })
      }
      // The api worker notices the module deserves a short doc and adds it to the plan (plan revision v2).
      if (key === 'api' && !docsProposed && ctx.nexusTools?.proposeGraphChange) {
        docsProposed = true
        await ctx.nexusTools.proposeGraphChange({
          type: 'ADD_TASK',
          reason: 'The API module needs a short doc that nothing in the plan covers.',
          evidence: 'api.txt exists and no task writes documentation for it.',
          changes: {
            tasks: [
              {
                key: 'docs',
                title: 'Document the API module',
                description: 'Create docs.txt describing the API module.',
                role: 'worker',
                dependencies: [],
                suggestedFiles: ['docs.txt'],
                acceptanceCriteria: ['docs.txt exists'],
                complexity: 'small',
                risk: 'low',
              },
            ],
            blocksProposer: false,
          },
        })
      }
      await ctx.sleep(200)
      await ctx.completeTurn({ text: `Created ${key}.txt${suffix ? ' (repaired)' : ''}.` })
    }

  /** Review output of the correctness / security reviewers: the first review of task `ui` requests changes. */
  const reviewer: FakeScript = async (spec, ctx) => {
    await ctx.sleep(150)
    const purpose = specPurpose(spec)
    if (purpose === 'critique') {
      await ctx.completeTurn({
        text: 'Critique ready.',
        structuredOutput: {
          summary: 'The candidates agree on the module split.',
          findings: [{ candidate: 'all', severity: 'low', issue: 'No candidate adds documentation.', recommendation: 'Optional.' }],
          preferredCandidate: 'Planner A (risk-first)',
        },
      })
      return
    }
    if (purpose === 'arbitrate') {
      // Accept every finding (the prompt lists them as "[index] ...").
      const indexes = [...spec.prompt.matchAll(/^\[(\d+)\] \(reported by /gm)].map((m) => Number(m[1]))
      await ctx.completeTurn({
        text: 'Arbitration done.',
        structuredOutput: { summary: 'Findings checked against the code.', decisions: indexes.map((findingIndex) => ({ findingIndex, accepted: true, reason: 'Confirmed in ui.txt.' })) },
      })
      return
    }
    const isUi = basename(spec.cwd) === 'ui'
    if (isUi && uiReviews++ === 0) {
      await ctx.completeTurn({
        text: 'Changes requested.',
        structuredOutput: {
          summary: 'ui.txt is missing required content.',
          findings: [
            {
              title: 'UI description is incomplete',
              description: 'ui.txt only contains the module name.',
              evidence: 'ui.txt has a single line.',
              severity: 'high',
              category: 'requirement_mismatch',
              file: 'ui.txt',
              lineStart: 1,
              lineEnd: 1,
              confidence: 'high',
              suggestedCorrection: 'Describe the UI module.',
            },
          ],
        },
      })
      return
    }
    await ctx.completeTurn({ text: 'Approved.', structuredOutput: { summary: 'No significant issues.', findings: [] } })
  }

  return scriptsByRole({
    // Planner sessions: the three consensus planners and the synthesizer all return the same plan.
    planner: async (spec, ctx) => {
      const marker = /\[demo:(stall|quota|fail)\]/.exec(spec.prompt)?.[1]
      if (marker === 'stall' || marker === 'quota' || marker === 'fail') behaviour = marker
      await ctx.emitText('Inspecting the repository and drafting a plan.')
      await ctx.sleep(200)
      if (behaviour === 'fail') {
        await ctx.completeTurn({ text: 'No plan.', structuredOutput: { summary: '' } })
        return
      }
      await ctx.completeTurn({ text: 'Plan ready.', structuredOutput: plan })
    },
    worker: writer(''),
    debugger: writer(' fixed'),
    reviewer,
    security_reviewer: reviewer,
    verifier: completeWith({
      text: 'Verified.',
      structuredOutput: { summary: 'All acceptance criteria are satisfied.', criteria: [], failures: [] },
    }),
  })
}
