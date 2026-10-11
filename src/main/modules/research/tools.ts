import type { AutonomyCapability, SecurityEventSeverity } from '@shared/autonomy'
import type { AgentRole, Run, Task } from '@shared/domain'
import { parseExtensionCall } from '@main/modules/agent-runtime/extension-tools'
import type { AutonomyGate } from '@main/modules/autonomy/gate'
import type { CapabilityNeed } from '@main/modules/autonomy/tool-capabilities'
import { checkUrl, type NetworkPolicy } from '@main/modules/network/policy'
import { ResearchRefused, renderEnvelope, type ResearchContext, type WebResearchProvider } from './provider'

/**
 * 0.8: the research tools as a session calls them. Every call is validated against its definition, then put
 * to the capability broker (through the session's gate), then carried out by the research provider under the
 * public-research network policy. A session of a project that is not enrolled gets these tools only where
 * the 0.7 setting already let its role read the web.
 */

export interface ExtensionSession {
  run: Run
  task: Task | null
  agentId: string
  role: AgentRole
  cwd: string
}

export interface ResearchToolsDeps {
  research: WebResearchProvider
  /** The gate of the session, or undefined when its project is not enrolled. */
  gateFor: (session: ExtensionSession) => AutonomyGate | undefined
  /** 0.7's setting: read-only roles of a project that is not enrolled may read the web when it is on. */
  legacyNetworkTools: () => boolean
  /** The policy research runs under, for the first look at an address before the broker is asked. */
  policy: () => NetworkPolicy
  /** A finding for the autonomy audit log (an injection taken out of a page). Quiet: it tells nobody. */
  record?: (session: ExtensionSession, severity: SecurityEventSeverity, action: string, resource: string, reason: string) => void
}

const WRITING: readonly AgentRole[] = ['worker', 'debugger']
const ANY = { kind: 'ANY' as const, value: '' }

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/** Which extension groups a session gets, and the handler for their calls. Null: none. */
export function createResearchTools(deps: ResearchToolsDeps): (session: ExtensionSession) => { groups: string[]; call: (input: unknown) => Promise<string> } | null {
  return (session) => {
    const gate = deps.gateFor(session)
    if (gate === undefined && !(deps.legacyNetworkTools() && !WRITING.includes(session.role))) return null
    const groups = ['research']
    const context: ResearchContext = { projectId: session.run.projectId, runId: session.run.id, taskId: session.task?.id ?? null }

    /** Asks the broker. Returns the refusal as text, or null when the call may proceed. */
    const refused = (toolName: string, capability: AutonomyCapability, why: string, action: string, resource: CapabilityNeed['resource'], inBoundary: boolean): string | null => {
      if (gate === undefined) return null
      const decision = gate.resolve({ agentId: session.agentId, toolName: `mcp__nexus__${toolName}`, input: {}, toolUseId: '' }, action, [{ capability, resource, why, inBoundary }], 'UNTRUSTED_WEB_CONTENT')
      return decision.behavior === 'allow' ? null : decision.behavior === 'deny' ? decision.reason : 'Not done.'
    }

    const call = async (input: unknown): Promise<string> => {
      const parsed = parseExtensionCall(input, groups)
      if (!parsed.ok) return `Not done: ${parsed.error}`
      const { def, args } = parsed
      try {
        if (def.name === 'research_search') {
          const query = String(args['query'])
          const no = refused(def.name, 'PUBLIC_WEB_RESEARCH', 'searches the public web', `research_search: ${query.slice(0, 200)}`, ANY, true)
          if (no !== null) return no
          return (await deps.research.search(context, query, { ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}) })).text
        }
        if (def.name === 'research_read' || def.name === 'research_download') {
          const url = String(args['url'])
          // The broker is asked about the host; whether the host is public is established here, from the
          // policy, and not from anything the caller says about it.
          const verdict = checkUrl(deps.policy(), url)
          const capability: AutonomyCapability = def.name === 'research_read' ? 'WEB_FETCH' : 'DOWNLOAD_RESEARCH_ARTIFACT'
          const no = refused(def.name, capability, def.name === 'research_read' ? 'reads a public web page' : 'fetches a file into quarantine', `${def.name}: ${url.slice(0, 300)}`, { kind: 'HOST', value: hostOf(url) }, verdict.allowed)
          if (no !== null) return no
          if (!verdict.allowed) return `Not opened: ${verdict.reason}`
          if (def.name === 'research_download') {
            const d = await deps.research.download(context, url)
            return d.state === 'QUARANTINED'
              ? `Held in quarantine as download ${d.id}: ${d.sniffed}, ${d.bytes} bytes, sha256 ${d.sha256}, from ${d.finalUrl}. It is not in the project and has not been opened or run. Putting a held file into the project is a separate step that the user decides.`
              : `Refused and not kept: ${d.refusal ?? 'the file is of a kind that is not held'} (content: ${d.sniffed}, ${d.bytes} bytes, from ${d.finalUrl}).`
          }
          const envelope = await deps.research.read(context, url, {
            ...(typeof args['question'] === 'string' ? { question: args['question'] } : {}),
            ...(typeof args['max_chars'] === 'number' ? { maxChars: args['max_chars'] } : {}),
            ...(args['refresh'] === true ? { refresh: true } : {}),
            ...(args['render'] === true ? { render: true } : {}),
          })
          if (envelope.screening.status === 'flagged' && !envelope.source.fromMemory) {
            const removed = Object.entries(envelope.screening.quarantined).map(([pattern, n]) => `${pattern} x${n}`).join(', ')
            deps.record?.(session, 'INJECTION_DETECTED', `research_read: ${envelope.source.url.slice(0, 300)}`, `host: ${envelope.source.publisher}`, `Instruction-like text was taken out of a page (${removed || 'hidden text'}); the rest was read as data. Artifact ${envelope.artifact.id}.`)
          }
          return renderEnvelope(envelope)
        }
        if (def.name === 'research_more') {
          return renderEnvelope(deps.research.readMore(context, String(args['artifact']), Number(args['offset']), typeof args['max_chars'] === 'number' ? args['max_chars'] : undefined))
        }
        return 'Not done: this session has no such tool.'
      } catch (e) {
        if (e instanceof ResearchRefused) return `Not done: ${e.message}`
        return 'Not done: the research could not be carried out.'
      }
    }
    return { groups, call }
  }
}
