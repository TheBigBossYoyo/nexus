import type { ContextCapabilities, OptimizationAction, TokenSettings } from '@shared/token'
import { techniqueEnabled } from '@shared/token'
import type { SessionContextOptions } from '@main/modules/agent-runtime/types'

/**
 * What each provider's runtime supports, and what NEXUS therefore asks of it. A capability that is false is
 * never requested: a session routed to Codex gets no Claude-specific option.
 */

const CLAUDE: ContextCapabilities = {
  provider: 'claude',
  promptCaching: 'automatic',
  stableSystemPrefix: true,
  perRequestUsage: true,
  contextUsageBreakdown: true,
  toolSearch: true,
  alwaysLoadTools: true,
  compactionEvents: true,
  thinkingTokens: true,
  nexusTools: true,
  sessionResume: true,
}

/** Codex reports cached input tokens after a turn and nothing else; NEXUS's tools are not offered to it. */
const CODEX: ContextCapabilities = {
  provider: 'codex',
  promptCaching: 'automatic',
  stableSystemPrefix: false,
  perRequestUsage: false,
  contextUsageBreakdown: false,
  toolSearch: false,
  alwaysLoadTools: false,
  compactionEvents: false,
  thinkingTokens: false,
  nexusTools: false,
  sessionResume: true,
}

const NONE: Omit<ContextCapabilities, 'provider'> = {
  promptCaching: 'none',
  stableSystemPrefix: false,
  perRequestUsage: false,
  contextUsageBreakdown: false,
  toolSearch: false,
  alwaysLoadTools: false,
  compactionEvents: false,
  thinkingTokens: false,
  nexusTools: false,
  sessionResume: false,
}

export function capabilitiesOf(provider: string): ContextCapabilities {
  if (provider === 'claude') return CLAUDE
  if (provider === 'codex') return CODEX
  // The scripted runtime of the tests stands in for Claude and reports what it is told to.
  if (provider === 'fake') return { ...CLAUDE, provider: 'fake' }
  return { ...NONE, provider }
}

/** Options a session asks its runtime for (see `SessionContextOptions`). */
export type ContextOptions = SessionContextOptions

export const BASELINE_CONTEXT_OPTIONS: ContextOptions = { stablePrefix: false, alwaysLoadNexusTools: false, contextUsageDetail: 'off' }

/** Fewer tools than this fit in the prompt comfortably; the SDK's own guidance is "fewer than about 10". */
export const UPFRONT_TOOL_LIMIT = 10

export interface ToolPlanInput {
  /** NEXUS tools the session gets. */
  nexusTools: number
  /** Tools of external MCP servers the project configured. Their count is unknown before the servers start; servers are counted. */
  externalServers: number
  settings: TokenSettings | undefined
}

export interface ToolPlan {
  alwaysLoadNexusTools: boolean
  action: Extract<OptimizationAction, 'DEFER_TOOLS' | 'LOAD_TOOLS_UPFRONT'>
  reason: string
}

/**
 * Whether the NEXUS tools are loaded upfront. The runtime defers MCP tool definitions behind tool search by
 * default, which costs a search round trip the first time a tool is needed. For a handful of small
 * definitions the round trip costs more than the definitions do. External servers are always left to the
 * runtime's default: their size is unknown and can be large.
 */
export function planTools(input: ToolPlanInput): ToolPlan {
  if (input.nexusTools === 0) return { alwaysLoadNexusTools: false, action: 'DEFER_TOOLS', reason: 'The session has no NEXUS tools.' }
  if (!techniqueEnabled(input.settings, 'toolLoading')) {
    return { alwaysLoadNexusTools: false, action: 'DEFER_TOOLS', reason: 'Tool loading is left to the runtime default (tool search): loading upfront is not an evidence-supported default yet.' }
  }
  if (input.nexusTools > UPFRONT_TOOL_LIMIT) {
    return { alwaysLoadNexusTools: false, action: 'DEFER_TOOLS', reason: `${input.nexusTools} NEXUS tools: more than ${UPFRONT_TOOL_LIMIT}, so their definitions stay behind tool search.` }
  }
  return { alwaysLoadNexusTools: true, action: 'LOAD_TOOLS_UPFRONT', reason: `${input.nexusTools} NEXUS tools: few enough that loading them upfront saves the search round trip.` }
}

export function planContextOptions(input: { settings: TokenSettings | undefined; nexusTools: number; externalServers: number }): { options: ContextOptions; tools: ToolPlan } {
  const tools = planTools(input)
  return {
    tools,
    options: {
      stablePrefix: techniqueEnabled(input.settings, 'stablePrefix'),
      alwaysLoadNexusTools: tools.alwaysLoadNexusTools,
      contextUsageDetail: input.settings?.contextUsageDetail ?? 'summary',
    },
  }
}
