import { describe, expect, it, vi } from 'vitest'
import { createV72Handlers } from '@main/modules/ipc/v72-handlers'
import type { ChatGPTConnection } from '@main/modules/intelligence/connection'
import type { GitService } from '@main/modules/git'
import { graphHarness } from '../../helpers/context-graph'

describe('compiled task admission', () => {
  it('admits exact raw input and rejects changed raw, project or mode', async () => {
    const h = graphHarness()
    try {
      const handlers = createV72Handlers(h.repos)
      const raw = '  Change a label\n'
      const spec = await handlers['compilation.preview']({
        projectId: h.project.id,
        raw,
        mode: 'EXACT',
      })
      const input = { projectId: h.project.id, specId: spec.id, raw, mode: 'EXACT' as const }
      expect(await handlers['compilation.validate'](input)).toEqual(spec)
      await expect(handlers['compilation.validate']({ ...input, raw: raw.trim() })).rejects.toThrow(
        'does not match',
      )
      await expect(handlers['compilation.validate']({ ...input, mode: 'LIGHT' })).rejects.toThrow(
        'does not match',
      )
    } finally {
      h.close()
    }
  })
  it('gives the compiler no note an agent wrote, and says how far the rest can be trusted', async () => {
    const h = graphHarness()
    try {
      const { TaskAdmissionService } = await import('@main/modules/intelligence/admission')
      await h.graph.syncProject(h.project.id)
      h.graph.writeNote({ space: h.space, title: 'Parser dependency', body: 'The telemetry parser appears to need the package left-pad-extra for every change.', author: { source: 'worker', runId: 'run-1', taskId: 'task-1', agentId: 'agent-1' } })
      h.graph.writeNote({ space: h.space, title: 'Parser freeze', body: 'The telemetry parser keeps its public API during the freeze week.', author: { source: 'user' } })
      const context = new TaskAdmissionService(h.repos).retrieve(h.project.id, 'Change the telemetry parser')
      const text = context.map((c) => c.text).join('\n')
      expect(text).toContain('keeps its public API')
      expect(text).toContain('user-provided')
      expect(text).not.toContain('left-pad-extra')
      // What looks like a credential in stored knowledge does not leave with it.
      h.graph.writeNote({ space: h.space, title: 'Parser staging access', body: 'The telemetry parser staging server takes api_key=Zx81kQ7pLm22vTt9 on every request.', author: { source: 'user' } })
      const again = new TaskAdmissionService(h.repos).retrieve(h.project.id, 'Change the telemetry parser staging').map((c) => c.text).join('\n')
      expect(again).toContain('staging server')
      expect(again).not.toContain('Zx81kQ7pLm22vTt9')
    } finally {
      h.close()
    }
  })
  it('blocks unavailable AUTO rather than starting from an uncompiled prompt', async () => {
    const h = graphHarness()
    try {
      const handlers = createV72Handlers(h.repos)
      const input = { projectId: h.project.id, raw: 'Build a leaderboard', mode: 'AUTO' as const }
      const spec = await handlers['compilation.preview'](input)
      expect(spec.status).toBe('WAITING_FOR_PROVIDER')
      await expect(handlers['compilation.validate']({ ...input, specId: spec.id })).rejects.toThrow(
        'waiting',
      )
    } finally {
      h.close()
    }
  })
  it('deduplicates concurrent inference and cache hits, then invalidates on repository change', async () => {
    const h = graphHarness()
    let head = 'head-one'
    try {
      const complete = vi.fn(async (instructions: string) =>
        instructions.startsWith('INTENT_DRIFT_CHECK')
          ? {
              changesIntent: false,
              expandsScope: false,
              conflicts: [],
              unjustifiedRequirements: [],
            }
          : { recommendations: [], scopeChanged: false, ambiguities: [] },
      )
      const connection = {
        provider: () => ({ complete }),
        status: () => ({ activeProfile: 'one', model: 'test', includedOnlyConfirmed: true }),
      } as unknown as ChatGPTConnection
      const handlers = createV72Handlers(h.repos, connection, {
        headCommit: async () => head,
      } as unknown as GitService)
      const input = {
        projectId: h.project.id,
        raw: 'Build a leaderboard',
        mode: 'STANDARD' as const,
      }
      const [first, second] = await Promise.all([
        handlers['compilation.preview'](input),
        handlers['compilation.preview'](input),
      ])
      expect(first.id).toBe(second.id)
      expect(complete).toHaveBeenCalledTimes(2)
      expect((await handlers['compilation.preview'](input)).id).toBe(first.id)
      expect(complete).toHaveBeenCalledTimes(2)
      head = 'head-two'
      await expect(
        handlers['compilation.validate']({ ...input, specId: first.id }),
      ).rejects.toThrow('stale')
      expect((await handlers['compilation.preview'](input)).id).not.toBe(first.id)
      expect(complete).toHaveBeenCalledTimes(4)
      head = 'head-one'
      const project = h.repos.projects.require(h.project.id)
      h.repos.projects.update(project.id, {
        profile: {
          ...project.profile!,
          commands: { build: null, test: 'node new-tests.js', lint: null, typecheck: null },
        },
      })
      await expect(
        handlers['compilation.validate']({ ...input, specId: first.id }),
      ).rejects.toThrow('stale')
    } finally {
      h.close()
    }
  })
})
