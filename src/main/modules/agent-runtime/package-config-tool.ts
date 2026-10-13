import { parseExtensionCall } from '@main/modules/agent-runtime/extension-tools'
import type { AutonomyGate } from '@main/modules/autonomy/gate'
import { inspectPackageConfig, renderPackageConfig, type InspectOptions } from '@main/modules/policies/package-config'
import type { ExtensionSession } from '@main/modules/research/tools'

/**
 * 0.8: `package_config_inspect`, the sanitized view of the package-manager configuration of a task's worktree.
 * It is an ordinary read of the project (READ_PROJECT, a profile capability every role that may read the project
 * holds): the answer holds no secret, which is the reason it exists. It never asks for READ_PROJECT_SECRETS; the
 * raw `.npmrc` stays the boundary it was. A project that is not enrolled has no gate and the tool is offered all
 * the same, since reading a worktree's own configuration needs no grant.
 */

export interface PackageConfigToolDeps {
  gateFor: (session: ExtensionSession) => AutonomyGate | undefined
  inspect?: InspectOptions
}

export function createPackageConfigTools(deps: PackageConfigToolDeps): (session: ExtensionSession) => { groups: string[]; call: (input: unknown) => Promise<string> } | null {
  return (session) => {
    const groups = ['package']
    const call = async (input: unknown): Promise<string> => {
      const parsed = parseExtensionCall(input, groups)
      if (!parsed.ok) return `Not done: ${parsed.error}`
      const { def, args } = parsed
      if (def.name !== 'package_config_inspect') return 'Not done: this session has no such tool.'
      const gate = deps.gateFor(session)
      if (gate !== undefined) {
        const decision = gate.resolve({ agentId: session.agentId, toolName: `mcp__nexus__${def.name}`, input: {}, toolUseId: '' }, def.name, [{ capability: 'READ_PROJECT', resource: { kind: 'ANY', value: '' }, why: 'reads the sanitized package-manager configuration of the task worktree', inBoundary: true }], 'UNTRUSTED_REPOSITORY_CODE')
        if (decision.behavior !== 'allow') return decision.behavior === 'deny' ? decision.reason : 'Not done.'
      }
      try {
        return renderPackageConfig(inspectPackageConfig(session.cwd, typeof args['directory'] === 'string' ? args['directory'] : undefined, deps.inspect))
      } catch (e) {
        // Only this module's own plain messages are passed on, never anything of a file.
        return `Not done: ${e instanceof Error ? (e.message.split('\n')[0] ?? '').slice(0, 200) : 'the configuration could not be read.'}`
      }
    }
    return { groups, call }
  }
}
