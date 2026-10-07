import type { ContextEdgeType, ContextNode, ContextNodeType, ContextStatus, ContextTrust } from '@shared/context-graph'
import type { RequestComponent, TokenBasis } from '@shared/token'
import type { Tone } from '../../lib/status'

/** Pure presentation rules of the Context view and the token sections: wording, tones and small derivations. */

export const TRUST_LABEL: Record<ContextTrust, string> = {
  VERIFIED: 'Verified',
  USER_PROVIDED: 'User provided',
  INFERRED: 'Inferred',
  GENERATED_SUMMARY: 'Derived summary',
  AGENT_NOTE: 'Agent note',
}

/** What each trust level means, in one sentence the inspector shows under the label. */
export const TRUST_MEANING: Record<ContextTrust, string> = {
  VERIFIED: 'Checked against the repository when it was recorded.',
  USER_PROVIDED: 'Stated by you.',
  INFERRED: 'Concluded by analysis or an approved agent statement; a lead to check.',
  GENERATED_SUMMARY: 'Computed from the entries below it; the entries are the knowledge.',
  AGENT_NOTE: 'Written by an agent and not verified.',
}

export const STATUS_LABEL: Record<ContextStatus, string> = {
  CURRENT: 'Current',
  STALE: 'Stale',
  SUPERSEDED: 'Superseded',
  CONFLICTED: 'In conflict',
  ARCHIVED: 'Archived',
  PROPOSED: 'Proposed',
}

export function statusTone(status: ContextStatus): Tone {
  switch (status) {
    case 'CURRENT':
      return 'success'
    case 'STALE':
      return 'waiting'
    case 'CONFLICTED':
      return 'danger'
    case 'PROPOSED':
      return 'review'
    case 'SUPERSEDED':
    case 'ARCHIVED':
      return 'neutral'
  }
}

export function trustTone(trust: ContextTrust): Tone {
  return trust === 'VERIFIED' || trust === 'USER_PROVIDED' ? 'success' : trust === 'AGENT_NOTE' ? 'warning' : 'neutral'
}

const TYPE_LABEL: Partial<Record<ContextNodeType, string>> = { SYMBOL: 'Interface', COMPONENT: 'Component', HISTORY_INDEX: 'History' }

export function typeLabel(type: ContextNodeType): string {
  return TYPE_LABEL[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ')
}

const EDGE_OUT: Record<ContextEdgeType, string> = {
  DEPENDS_ON: 'Depends on',
  IMPLEMENTS: 'Implements',
  USES: 'Uses',
  PROVIDES: 'Provides',
  CONSUMES: 'Consumes',
  TESTED_BY: 'Tested by',
  AFFECTED_BY: 'Affected by',
  SUPERSEDES: 'Supersedes',
  DERIVED_FROM: 'Derived from',
  DECIDED_BY: 'Governed by',
  RELATED_TO: 'Related to',
  BLOCKED_BY: 'Blocked by',
  FIXED_BY: 'Fixed by',
  INTRODUCED_BY: 'Introduced by',
  VALIDATED_BY: 'Validated by',
  CONFLICTS_WITH: 'Conflicts with',
}
const EDGE_IN: Record<ContextEdgeType, string> = {
  DEPENDS_ON: 'Depended on by',
  IMPLEMENTS: 'Implemented by',
  USES: 'Used by',
  PROVIDES: 'Provided by',
  CONSUMES: 'Consumed by',
  TESTED_BY: 'Tests',
  AFFECTED_BY: 'Affects',
  SUPERSEDES: 'Superseded by',
  DERIVED_FROM: 'Source of',
  DECIDED_BY: 'Governs',
  RELATED_TO: 'Related to',
  BLOCKED_BY: 'Blocks',
  FIXED_BY: 'Fixes',
  INTRODUCED_BY: 'Introduced',
  VALIDATED_BY: 'Validates',
  CONFLICTS_WITH: 'Conflicts with',
}

export function edgeLabel(type: ContextEdgeType, direction: 'out' | 'in'): string {
  return direction === 'out' ? EDGE_OUT[type] : EDGE_IN[type]
}

/** Relations grouped by their label, in a fixed order, for the inspector. */
export function groupRelations<T extends { edge: { type: ContextEdgeType }; node: ContextNode }>(outgoing: readonly T[], incoming: readonly T[]): { label: string; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const r of outgoing) groups.set(edgeLabel(r.edge.type, 'out'), [...(groups.get(edgeLabel(r.edge.type, 'out')) ?? []), r])
  for (const r of incoming) groups.set(edgeLabel(r.edge.type, 'in'), [...(groups.get(edgeLabel(r.edge.type, 'in')) ?? []), r])
  return [...groups.entries()].map(([label, items]) => ({ label, items })).sort((a, b) => a.label.localeCompare(b.label))
}

/** What the inspector says above a node that is not plainly current. Null for a current node. */
export function statusNotice(node: Pick<ContextNode, 'status' | 'trust'>): { tone: Tone; text: string } | null {
  switch (node.status) {
    case 'STALE':
      return { tone: 'waiting', text: 'A file this is based on changed since it was recorded. Agents are not given it as a fact until it is confirmed or verified again.' }
    case 'CONFLICTED':
      return { tone: 'danger', text: 'Another current entry states this subject differently. Agents are shown both, with a warning. Supersede one of them to resolve it.' }
    case 'SUPERSEDED':
      return { tone: 'neutral', text: 'Replaced by a later entry. Kept as history; agents do not receive it unless they ask for history.' }
    case 'ARCHIVED':
      return { tone: 'neutral', text: 'Archived. Kept as history; agents do not receive it unless they ask for history.' }
    case 'PROPOSED':
      return { tone: 'review', text: 'Proposed and not yet approved. Agents do not receive it.' }
    case 'CURRENT':
      return node.trust === 'AGENT_NOTE' ? { tone: 'warning', text: 'An unverified agent note. Agents see it marked as a lead to check, and it is not used for high-risk work.' } : null
  }
}

export const COMPONENT_LABEL: Record<RequestComponent, string> = {
  SYSTEM_CORE: 'Runtime system prompt',
  SECURITY_POLICY: 'Security policy',
  ROLE: 'Role prompt',
  TOOL_DEFINITIONS: 'Tool definitions',
  PROJECT_FACTS: 'Project facts',
  CONTEXT_GRAPH: 'Context Graph',
  REPOSITORY_CONTEXT: 'Repository state',
  TASK: 'Task',
  ACCEPTANCE_CRITERIA: 'Acceptance criteria',
  DEPENDENCY_HANDOFF: 'Dependency results and handoffs',
  MESSAGES: 'Messages',
  HISTORY: 'Conversation',
  TOOL_RESULTS: 'Tool results',
  MEMORY: 'Memory',
  REVIEW_FINDINGS: 'Review findings',
  DYNAMIC_RUNTIME_STATE: 'Attempt and failure state',
  THINKING_HISTORY: 'Thinking',
  OTHER: 'Other',
}

export const BASIS_LABEL: Record<TokenBasis, string> = { exact: 'Counted by the runtime', observed: 'Reported by the runtime', estimated: 'Estimated' }

/** "68%" for a share of 0.684, an em dash when there is nothing to divide. Whole percentages only. */
export function percent(share: number | null): string {
  return share === null || !Number.isFinite(share) ? '—' : `${Math.round(share * 100)}%`
}

/** The causes NEXUS can name for a prefix that was written again, in words. */
export const MISS_CAUSE_LABEL: Record<string, string> = {
  FIRST_USE: 'First session with this prefix',
  TOOLS_CHANGED: 'The tool set changed',
  SYSTEM_CHANGED: 'The role prompt or a runtime option changed',
  MODEL_CHANGED: 'The model changed',
  EFFORT_CHANGED: 'The effort level changed',
  THINKING_CHANGED: 'The thinking setting changed',
  PROJECT_CONTEXT_CHANGED: 'The project context changed',
  SECURITY_POLICY_CHANGED: 'The security policy changed',
  DYNAMIC_PREFIX_CONTAMINATION: 'Per-session text in the prefix',
  EXPIRED: 'Longer than the cache lifetime since the last use',
  UNKNOWN: 'No difference found in what NEXUS controls',
}
