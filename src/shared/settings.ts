import { z } from 'zod'
import {
  AGENT_ROLES,
  AgentRoleSchema,
  ModelTierSchema,
  PresetSchema,
  type AgentRole,
  type ModelTier,
  type Preset,
  type RunConfig,
  type CheckCommands,
} from './domain'
import { ContainmentSettingSchema, ExecutionProfileSchema } from './security'
import { DEFAULT_USAGE_SETTINGS, UsageSettingsSchema } from './v3'
import { DEFAULT_TOKEN_SETTINGS, TokenSettingsSchema } from './token'

export const McpServerSettingSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  type: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  enabled: z.boolean(),
  /** Roles allowed to use this server. Empty means no role. */
  roles: z.array(AgentRoleSchema),
})
export type McpServerSetting = z.infer<typeof McpServerSettingSchema>

const rolePolicy = z.object(
  Object.fromEntries(AGENT_ROLES.map((r) => [r, ModelTierSchema])) as Record<
    AgentRole,
    typeof ModelTierSchema
  >,
)

export const SettingsSchema = z.object({
  claude: z.object({
    /** When true, ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped from every agent's environment. */
    subscriptionMode: z.boolean(),
    /** Optional override for the Claude executable. Empty uses the binary bundled with the SDK. */
    executablePath: z.string(),
  }),
  models: z.object({
    /** Tier → model id or alias as reported by the SDK's supportedModels(). Empty = runtime default. */
    tiers: z.object({ strongest: z.string(), balanced: z.string(), fast: z.string() }),
    rolePolicy,
  }),
  execution: z.object({
    defaultPreset: PresetSchema,
    maxParallelAgents: z.number().int().min(1).max(16),
    /** 0.9: how often a shown progress estimate is refreshed when nothing happens, in seconds. Five minutes unless set. */
    progressRefreshSeconds: z.number().int().min(30).max(3600).optional(),
    /** 0.9: the network recovery policy (see NetworkRecoveryPolicy); normalized where it is read. Absent: the default. */
    networkRecovery: z.record(z.string(), z.unknown()).optional(),
    maximumPresetAgents: z.number().int().min(1).max(16),
    maxTurnsPerAgent: z.number().int().min(1).max(1000),
    maxRetriesPerTask: z.number().int().min(0).max(10),
    maxDurationMinutes: z.number().int().min(1).max(24 * 60),
    maxIterations: z.number().int().min(1).max(50),
    requirePlanApproval: z.boolean(),
    sessionRotationTurns: z.number().int().min(0).max(1000),
    leaseMinutes: z.number().int().min(1).max(240),
    checkTimeoutMinutes: z.number().int().min(1).max(120),
    /** 0.7: how strictly agent commands and scripts are gated. Not a sandbox in either mode. Old stored settings read as STANDARD. */
    profile: ExecutionProfileSchema.default('STANDARD'),
    /** 0.8: the operating-system containment of project code in enrolled projects. Old stored settings read as STRONGEST. */
    containment: ContainmentSettingSchema.default('STRONGEST'),
  }),
  git: z.object({
    /** Remove task worktrees after a successful merge into the integration branch. */
    removeWorktreesOnSuccess: z.boolean(),
    commitAuthorName: z.string(),
    commitAuthorEmail: z.string(),
  }),
  permissions: z.object({
    /** Allow WebFetch/WebSearch for read-only roles. */
    allowNetworkTools: z.boolean(),
    /** Extra shell command prefixes that never need approval, e.g. "pnpm test". */
    safeCommandPrefixes: z.array(z.string()),
  }),
  memory: z.object({
    enabled: z.boolean(),
    maxEntriesPerContext: z.number().int().min(0).max(50),
    autoApproveVerifierMemory: z.boolean(),
  }),
  mcp: z.object({ servers: z.array(McpServerSettingSchema) }),
  appearance: z.object({
    theme: z.enum(['dark', 'light']),
    density: z.enum(['compact', 'comfortable']),
    fontSize: z.number().int().min(10).max(20),
  }),
  advanced: z.object({
    debugSdk: z.boolean(),
  }),
  /** v0.3. How NEXUS behaves around Claude usage limits. */
  usage: UsageSettingsSchema,
  /** 0.7.1. Context and token efficiency. Old stored settings read as the defaults. */
  tokens: TokenSettingsSchema.default(DEFAULT_TOKEN_SETTINGS),
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_ROLE_POLICY: Record<AgentRole, ModelTier> = {
  planner: 'strongest',
  architect: 'strongest',
  worker: 'balanced',
  debugger: 'strongest',
  reviewer: 'strongest',
  verifier: 'strongest',
  researcher: 'balanced',
  security_reviewer: 'strongest',
}

export const DEFAULT_SETTINGS: Settings = {
  claude: { subscriptionMode: true, executablePath: '' },
  models: {
    // Aliases are resolved by the Claude runtime, so they do not go stale with model releases.
    tiers: { strongest: 'opus', balanced: 'sonnet', fast: 'haiku' },
    rolePolicy: DEFAULT_ROLE_POLICY,
  },
  execution: {
    defaultPreset: 'balanced',
    maxParallelAgents: 4,
    maximumPresetAgents: 8,
    maxTurnsPerAgent: 80,
    maxRetriesPerTask: 2,
    maxDurationMinutes: 240,
    maxIterations: 3,
    requirePlanApproval: true,
    sessionRotationTurns: 60,
    leaseMinutes: 30,
    checkTimeoutMinutes: 15,
    profile: 'STANDARD',
    containment: 'STRONGEST',
  },
  git: {
    removeWorktreesOnSuccess: false,
    commitAuthorName: 'NEXUS Agent',
    commitAuthorEmail: 'nexus-agent@localhost',
  },
  permissions: { allowNetworkTools: false, safeCommandPrefixes: [] },
  memory: { enabled: true, maxEntriesPerContext: 8, autoApproveVerifierMemory: false },
  mcp: { servers: [] },
  appearance: { theme: 'light', density: 'compact', fontSize: 13 },
  advanced: { debugSdk: false },
  usage: DEFAULT_USAGE_SETTINGS,
  tokens: DEFAULT_TOKEN_SETTINGS,
}

/** ECO routes everything except planning/verification one tier down and halves parallelism. */
export function presetRolePolicy(
  preset: Preset,
  base: Record<AgentRole, ModelTier>,
): Record<AgentRole, ModelTier> {
  if (preset !== 'eco') return { ...base }
  const down = (t: ModelTier): ModelTier => (t === 'strongest' ? 'balanced' : t)
  return {
    ...base,
    architect: down(base.architect),
    worker: down(base.worker),
    debugger: down(base.debugger),
    researcher: 'fast',
    reviewer: down(base.reviewer),
    security_reviewer: down(base.security_reviewer),
  }
}

export function presetMaxAgents(preset: Preset, settings: Settings): number {
  switch (preset) {
    case 'eco':
      return 2
    case 'balanced':
      return Math.min(4, Math.max(1, settings.execution.maxParallelAgents))
    case 'maximum':
      return settings.execution.maximumPresetAgents
  }
}

export function buildRunConfig(
  settings: Settings,
  preset: Preset,
  checks: CheckCommands,
  respectProjectClaudeConfig: boolean,
  overrides: Partial<RunConfig> = {},
): RunConfig {
  return {
    maxParallelAgents: presetMaxAgents(preset, settings),
    maxTurnsPerAgent: settings.execution.maxTurnsPerAgent,
    maxRetriesPerTask: settings.execution.maxRetriesPerTask,
    maxDurationMinutes: settings.execution.maxDurationMinutes,
    maxIterations: settings.execution.maxIterations,
    requirePlanApproval: settings.execution.requirePlanApproval,
    modelPolicy: presetRolePolicy(preset, settings.models.rolePolicy),
    checks,
    respectProjectClaudeConfig,
    subscriptionMode: settings.claude.subscriptionMode,
    sessionRotationTurns: settings.execution.sessionRotationTurns,
    leaseMinutes: settings.execution.leaseMinutes,
    enabledMcpServers: settings.mcp.servers.filter((s) => s.enabled).map((s) => s.name),
    ...overrides,
  }
}

/**
 * The changes to the settings that let NEXUS start another program, or widen what agents may do without being
 * asked. Each is one sentence shown to the user in a native confirmation before the change is stored. A change
 * that only narrows (a program removed, a prefix removed, a stricter profile) is not listed.
 */
export function sensitiveSettingsChanges(before: Settings, after: Settings): string[] {
  const changes: string[] = []
  const short = (text: string): string => (text.length > 160 ? `${text.slice(0, 159)}…` : text)
  if (after.claude.executablePath.trim() !== '' && after.claude.executablePath !== before.claude.executablePath) changes.push(short(`Run this program as the Claude runtime: ${after.claude.executablePath}`))
  const known = new Map(before.mcp.servers.map((server) => [server.name, JSON.stringify(server)]))
  for (const server of after.mcp.servers) {
    if (!server.enabled || known.get(server.name) === JSON.stringify(server)) continue
    changes.push(short(server.type === 'stdio' ? `Start this program as the MCP server "${server.name}": ${[server.command ?? '', ...(server.args ?? [])].join(' ')}` : `Connect agents to the MCP server "${server.name}" at ${server.url ?? ''}`))
  }
  const prefixes = new Set(before.permissions.safeCommandPrefixes)
  for (const prefix of after.permissions.safeCommandPrefixes) if (!prefixes.has(prefix)) changes.push(short(`Let agents run commands that begin with "${prefix}" without asking`))
  if (after.permissions.allowNetworkTools && !before.permissions.allowNetworkTools) changes.push('Let read-only agents fetch pages from the web')
  if (before.execution.profile === 'RESTRICTED' && after.execution.profile === 'STANDARD') changes.push('Lower the execution profile from RESTRICTED to STANDARD')
  const strength = { STANDARD: 0, RESTRICTED: 1, STRONGEST: 2, ISOLATED: 3 } as const
  if (strength[after.execution.containment] < strength[before.execution.containment]) {
    changes.push(
      after.execution.containment === 'STANDARD'
        ? 'Run project code in enrolled projects with no containment at all (as you, with your files, credentials and network)'
        : `Lower the containment of project code from ${before.execution.containment} to ${after.execution.containment}`,
    )
  }
  if (after.memory.autoApproveVerifierMemory && !before.memory.autoApproveVerifierMemory) changes.push('Keep what verifier agents propose for the project memory without your review')
  if (!after.claude.subscriptionMode && before.claude.subscriptionMode) changes.push('Let API keys from the environment reach the agent sessions')
  if (after.advanced.debugSdk && !before.advanced.debugSdk) changes.push('Write the debug output of the Claude runtime to the NEXUS log (it can contain prompts and tool input)')
  return changes
}
