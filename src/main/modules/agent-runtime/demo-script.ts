import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { MissionPlan } from '@shared/domain'
import { completeWith, scriptsByRole, type FakeScript } from './fake-runtime'

/**
 * Scripted agents for UI end-to-end tests (`NEXUS_FAKE_RUNTIME=1`, unpackaged builds only).
 * No Claude usage. The first review of task `ui` requests changes so the repair loop is exercised.
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

  const writer =
    (suffix: string): FakeScript =>
    async (spec, ctx) => {
      // A task whose key clashes with an existing branch (e.g. `integration`) gets a short id suffix on its directory.
      const key = basename(spec.cwd).replace(/-[0-9a-f]{8}$/, '')
      await ctx.emitText(`Working on ${key} in ${spec.cwd}`)
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
      await ctx.sleep(200)
      await ctx.completeTurn({ text: `Created ${key}.txt${suffix ? ' (repaired)' : ''}.` })
    }

  return scriptsByRole({
    planner: async (_spec, ctx) => {
      await ctx.emitText('Inspecting the repository and drafting a plan.')
      await ctx.sleep(200)
      await ctx.completeTurn({ text: 'Plan ready.', structuredOutput: plan })
    },
    worker: writer(''),
    debugger: writer(' fixed'),
    reviewer: async (spec, ctx) => {
      await ctx.sleep(150)
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
    },
    verifier: completeWith({
      text: 'Verified.',
      structuredOutput: { summary: 'All acceptance criteria are satisfied.', criteria: [], failures: [] },
    }),
  })
}
