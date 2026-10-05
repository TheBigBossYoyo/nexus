import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { MissionPlan } from '@shared/domain'
import { completeWith, scriptsByRole, specPurpose, type FakeScript } from './fake-runtime'

/**
 * Scripted agents for UI end-to-end tests (`NEXUS_FAKE_RUNTIME=1`, unpackaged builds only).
 * No Claude usage. The first review of task `ui` requests changes so the repair loop is exercised.
 *
 * A marker in the mission text selects how the mission goes, so UI tests can reach every way an
 * overnight run ends: `[demo:stall]` (workers never finish), `[demo:quota]` (a worker hits a usage
 * limit that reports no reset time), `[demo:fail]` (the planner never returns a valid plan),
 * `[demo:quota-reset]` (the first worker hits a limit with an exact reset a few seconds ahead, then the
 * account is available again: automatic resume) and `[demo:quota-unknown]` (a limit with no reset time; the
 * first availability probe still finds it limited, the second finds it available).
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
  let behaviour: 'normal' | 'stall' | 'quota' | 'fail' | 'quota-reset' | 'quota-unknown' = 'normal'
  let quotaHit = false

  const writer =
    (suffix: string): FakeScript =>
    async (spec, ctx) => {
      // A task whose key clashes with an existing branch (e.g. `integration`) gets a short id suffix on its directory.
      const key = basename(spec.cwd).replace(/-[0-9a-f]{8}$/, '')
      await ctx.emitText(`Working on ${key} in ${spec.cwd}`)
      // 0.5: a task of a cross-repository mission. The provider extends its contract; a consumer makes its copy
      // of the contract equal to the content it was given.
      if (spec.prompt.includes('part of a change across several repositories')) {
        const write = async (path: string, content: string): Promise<void> => {
          const target = join(spec.cwd, path)
          await ctx.useTool('Write', { file_path: target, content: content.slice(0, 200) }, async () => {
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, content)
            return 'File written'
          })
        }
        const provided = /PROVIDES the contract "[^"]+" \([^)]+\) at (\S+?)\. /.exec(spec.prompt)?.[1]
        if (provided) {
          const current = await readFile(join(spec.cwd, provided), 'utf8').catch(() => '{}')
          let next = `${current}\n`
          try {
            const schema = JSON.parse(current) as { properties?: Record<string, unknown> }
            const marker = spec.prompt.includes('[demo:breaking]') ? 'renamed' : 'added'
            const properties = { ...(schema.properties ?? {}) }
            if (marker === 'renamed') delete properties[Object.keys(properties).at(-1) ?? '']
            properties[`${marker}Field${Object.keys(properties).length}`] = { type: 'string' }
            next = `${JSON.stringify({ ...schema, properties }, null, 2)}\n`
          } catch {
            // Not JSON: a line is appended, which is still a change of the contract file.
          }
          await write(provided, next)
        }
        for (const m of spec.prompt.matchAll(/BEGIN CONTRACT ([0-9a-f]+)\n([\s\S]*?)\nEND CONTRACT \1\nThis repository keeps its own copy of the contract at (\S+?)\. /g)) {
          // `[demo:skip-consumer]` in the goal leaves the copies as they are (a consumer left behind).
          if (spec.prompt.includes('[demo:skip-consumer]')) continue
          await write(m[3] ?? 'contract.copy', `${m[2] ?? ''}\n`)
        }
        await write(`change-${Date.now().toString(36)}.txt`, 'cross-repository change\n')
        await ctx.sleep(200)
        await ctx.completeTurn({ text: provided ? `Extended the contract at ${provided}.` : 'Adapted this repository to the contract.' })
        return
      }
      if (behaviour === 'stall') {
        // Until the session is stopped (a pause, the mission deadline, or the app closing).
        await ctx.sleep(60 * 60_000)
        return
      }
      if ((behaviour === 'quota-reset' || behaviour === 'quota-unknown') && !quotaHit) {
        quotaHit = true
        if (behaviour === 'quota-reset') {
          const seconds = Number(process.env['NEXUS_USAGE_DEMO_RESET_S'] ?? 6)
          ctx.usage.limit(ctx.usage.now() + seconds * 1000)
        } else {
          // No reset time: the account stays limited through the first availability check and is available
          // again after it, so the second check succeeds.
          const sim = ctx.usage
          const checksBefore = sim.probes
          sim.limit(null)
          const watch = setInterval(() => {
            if (sim.probes <= checksBefore) return
            sim.restore()
            clearInterval(watch)
          }, 100)
          watch.unref()
        }
        await ctx.rateLimit({ status: 'rejected', resetsAt: ctx.usage.resetAtSeconds(), limitType: 'five_hour' })
        await ctx.completeTurn({ text: 'Usage limit reached.', outcome: 'quota' })
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
      // A later mission of a program starts from the earlier one's result: the file is there already, so the
      // work of this mission is one more line rather than nothing.
      const existing = await readFile(target, 'utf8').catch(() => null)
      const content = existing !== null && existing.startsWith(`${key}${suffix}\n`) ? `${existing}${key} revised\n` : `${key}${suffix}\n`
      await ctx.useTool('Write', { file_path: target, content: content.trimEnd() }, async () => {
        await writeFile(target, content)
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

  /**
   * Program-level reasoning (0.4): the read-only sessions that plan milestones, judge a milestone and reassess
   * the plan answer with JSON in a fenced block, as the real ones are asked to. The first milestone is
   * rejected on its first attempt, so the demo shows a rejection, a retry, a backlog proposal and a memory entry.
   */
  const fence = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
  const demoMilestone = (key: string, title: string, objective: string, dependsOn: string[] = []): Record<string, unknown> => ({
    key,
    title,
    objective,
    acceptanceCriteria: [`${title}: the module files exist and describe their module`],
    workstream: 'Modules',
    expertise: key === 'hardening' ? 'reliability' : 'backend',
    dependsOn,
    complexity: 'small',
    risk: 'low',
  })
  const researcher: FakeScript = async (spec, ctx) => {
    await ctx.sleep(200)
    const p = spec.prompt
    if (p.includes('NEXUS PROGRAM PLANNER')) {
      await ctx.completeTurn({
        text: `The goal splits into two milestones.\n\n${fence({
          goal: 'Build the modules, then harden their integration.',
          successCriteria: ['The modules exist and are integrated'],
          milestones: [demoMilestone('foundation', 'Module foundation', 'Create the API and UI modules and integrate them.'), demoMilestone('hardening', 'Integration hardening', 'Revisit the modules and tighten their integration.', ['foundation'])],
          risks: ['The modules drift apart'],
          constraints: [],
        })}`,
      })
      return
    }
    if (p.includes('NEXUS MILESTONE VERIFIER')) {
      // Decided from the prompt, not from a counter, so a restart of the app does not make it reject again.
      const first = p.includes('<milestone>\nModule foundation\n') && p.includes('<previous_gaps>\n- none\n')
      await ctx.completeTurn({
        text: fence({
          verdict: first ? 'rejected' : 'accepted',
          criteria: [{ criterion: 'The module files exist and describe their module', met: !first, evidence: first ? 'ui.txt describes the module in one line only.' : 'api.txt, ui.txt and integration.txt are in the diff.' }],
          gaps: first ? ['The UI module description is too thin to integrate against'] : [],
          backlog: first ? [{ title: 'No test covers the integration file', description: 'integration.txt is written by hand and nothing checks it.', category: 'test_gap', severity: 'medium', evidence: 'The diff adds integration.txt and no test.', complexity: 'small', dependencies: [], recommendedMilestone: null }] : [],
          memory: first ? [{ kind: 'interface', title: 'Module files are the integration contract', content: 'The integration task reads api.txt and ui.txt; their first line is the module name.', evidence: 'integration.txt is produced from api.txt and ui.txt in the diff.', tags: ['modules', 'integration'] }] : [],
        }),
      })
      return
    }
    if (p.includes('NEXUS PROGRAM REPLANNER')) {
      const asked = /<user_request>\n([\s\S]*?)\n<\/user_request>/.exec(p)?.[1] ?? null
      if (!asked) {
        await ctx.completeTurn({ text: fence({ action: 'keep', reason: 'What happened does not change the remaining plan.', milestones: [], defer: [], strategyNote: null }) })
        return
      }
      // Keep what remains as it is and add the milestone the user asked for.
      const block = /<remaining_milestones>\n([\s\S]*?)\n<\/remaining_milestones>/.exec(p)?.[1] ?? ''
      const remaining = [...block.matchAll(/^- ([a-z0-9-]+) \[[A-Z_]+\] ([^:]+): (.*?)(?: \(depends on ([^)]*)\))?$/gm)].map((m) => demoMilestone(m[1] ?? '', (m[2] ?? '').trim(), (m[3] ?? '').trim(), m[4] ? m[4].split(', ') : []))
      await ctx.completeTurn({
        text: fence({ action: 'revise', reason: `The user asked: ${asked.slice(0, 200)}`, milestones: [...remaining, demoMilestone('requested', 'Requested follow-up', asked.slice(0, 300))], defer: [], strategyNote: null }),
      })
      return
    }
    if (p.includes('NEXUS WORKSPACE PLANNER')) {
      // One task per allowed repository, each after the repositories it depends on, naming the contracts it touches.
      const block = /<workspace>\n([\s\S]*?)\n<\/workspace>/.exec(p)?.[1] ?? ''
      // The description has three lists; repositories are the first, up to the line that starts the dependencies.
      const repositoryList = block.split(/^Dependencies /m)[0] ?? ''
      const repositories = [...repositoryList.matchAll(/^- ([a-z0-9-]+) \[[a-z_]+\](?! \(NOT allowed)/gm)].map((m) => m[1] ?? '')
      const edges = [...block.matchAll(/^- ([a-z0-9-]+) -> ([a-z0-9-]+) \(/gm)].map((m) => ({ from: m[1] ?? '', to: m[2] ?? '' }))
      const contracts = [...block.matchAll(/^- ([a-z0-9-]+) \[[a-z_]+\] ([a-z0-9-]+):\S+; consumers: (.*)$/gm)].map((m) => ({ key: m[1] ?? '', provider: m[2] ?? '', consumers: [...(m[3] ?? '').matchAll(/([a-z0-9-]+)(?: \(copy at [^)]*\))?/g)].map((c) => c[1] ?? '') }))
      const tasks = repositories.map((repository) => ({
        key: `change-${repository}`.slice(0, 40),
        repository,
        title: `Change ${repository}`,
        objective: `Make the change in ${repository}.`,
        acceptanceCriteria: [`${repository} carries the change`],
        dependsOn: [...new Set(edges.filter((e) => e.from === repository && repositories.includes(e.to)).map((e) => `change-${e.to}`.slice(0, 40)))],
        contracts: contracts.filter((c) => c.provider === repository || c.consumers.includes(repository)).map((c) => c.key),
      }))
      await ctx.completeTurn({ text: fence({ summary: 'Change the provider first, then each consumer.', tasks, risks: [] }) })
      return
    }
    if (p.includes('NEXUS BACKGROUND ANALYSIS')) {
      await ctx.completeTurn({
        text: fence({
          summary: 'Read the repository entry point and its manifest.',
          proposals: [{ title: 'The entry point has no test', description: 'src/index.js exports a value nothing tests.', category: 'test_gap', severity: 'low', evidence: 'src/index.js:1 and no test directory', complexity: 'small', dependencies: [], recommendedMilestone: null }],
        }),
      })
      return
    }
    await ctx.completeTurn({ text: 'Answer: this is the scripted runtime.' })
  }

  return scriptsByRole({
    researcher,
    // Planner sessions: the three consensus planners and the synthesizer all return the same plan.
    planner: async (spec, ctx) => {
      const marker = /\[demo:(stall|quota|fail|quota-reset|quota-unknown)\]/.exec(spec.prompt)?.[1]
      if (marker === 'stall' || marker === 'quota' || marker === 'fail' || marker === 'quota-reset' || marker === 'quota-unknown') {
        behaviour = marker
      }
      await ctx.emitText('Inspecting the repository and drafting a plan.')
      await ctx.sleep(200)
      if (behaviour === 'fail') {
        await ctx.completeTurn({ text: 'No plan.', structuredOutput: { summary: '' } })
        return
      }
      // 0.5: a task of a cross-repository mission is one task here, and its worker is handed the whole task
      // text (the contract it provides or consumes), which is what `writer` acts on.
      const at = spec.prompt.indexOf('part of a change across several repositories')
      if (at >= 0) {
        const from = spec.prompt.lastIndexOf('Task "', at)
        const to = spec.prompt.indexOf('</goal>', at)
        const text = spec.prompt.slice(from >= 0 ? from : at, to >= 0 ? to + '</goal>'.length : undefined)
        const change = { ...plan.tasks[0], id: 'change', title: 'Make the cross-repository change', description: text, suggestedFiles: [], acceptanceCriteria: ['The change is in this repository'] }
        await ctx.completeTurn({ text: 'Plan ready.', structuredOutput: { ...plan, summary: 'One change in this repository.', acceptanceCriteria: ['The change is in this repository'], tasks: [change] } })
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
