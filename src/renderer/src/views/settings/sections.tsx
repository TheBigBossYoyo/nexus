import { AUTO_DEFAULTS, type Technique, type TechniqueSwitch } from '@shared/token'
import { useState, type ReactNode } from 'react'
import { AGENT_ROLES, MODEL_TIERS, PRESETS, type AgentRole, type ModelTier } from '@shared/domain'
import type { McpServerSetting, Settings } from '@shared/settings'
import { useAppInfo, useModels, useOpenDataDir } from '../../lib/queries'
import { cn } from '../../lib/cn'
import {
  Badge,
  Button,
  DataTable,
  ErrorNote,
  Field,
  Input,
  InlineCode,
  KeyValue,
  NumberField,
  Notice,
  Select,
  Textarea,
  Toggle,
  TrashIcon,
  PlusIcon,
  IconButton,
  Loading,
  type Column,
  type SelectOption,
} from '../../components/ui'
import { PROFILE_EXPLANATION } from '../security/securityModel'
import { buildMcpServer, type McpDraft } from './settingsForm'

export interface SectionProps {
  draft: Settings
  /** Shallow-merge a patch into one top-level settings group. */
  set: <K extends keyof Settings>(key: K, patch: Partial<Settings[K]>) => void
  /** Validation message for a dotted path, if any. */
  error: (path: string) => string | undefined
}

const TIER_LABEL: Record<ModelTier, string> = { strongest: 'Strongest', balanced: 'Balanced', fast: 'Fast' }
const ROLE_LABEL = (r: AgentRole) => r.replace('_', ' ')

function Stack({ children }: { children: ReactNode }) {
  return <div className="flex max-w-xl flex-col gap-4">{children}</div>
}

export function ClaudeSection({ draft, set, error }: SectionProps) {
  return (
    <Stack>
      <Toggle
        checked={draft.claude.subscriptionMode}
        onChange={(v) => set('claude', { subscriptionMode: v })}
        label="Subscription Mode"
        description="Strip ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from every agent environment."
        data-testid="settings-subscription-mode"
      />
      <Field
        label="Claude executable path"
        hint="Leave empty to use the Claude binary bundled with the SDK."
        error={error('claude.executablePath')}
      >
        {(id) => (
          <Input
            id={id}
            className="font-mono"
            value={draft.claude.executablePath}
            placeholder="C:\path\to\claude.exe"
            onChange={(e) => set('claude', { executablePath: e.target.value })}
          />
        )}
      </Field>
    </Stack>
  )
}

export function ModelsSection({ draft, set, error }: SectionProps) {
  const models = useModels()
  const options = (current: string): SelectOption<string>[] => {
    const list: SelectOption<string>[] = [{ value: '', label: 'Runtime default' }]
    for (const m of models.data ?? []) list.push({ value: m.value, label: `${m.displayName} (${m.value})` })
    // Keep a configured value selectable even if the runtime no longer lists it.
    if (current && !list.some((o) => o.value === current)) list.push({ value: current, label: `${current} (not reported by runtime)` })
    return list
  }

  const columns: Column<AgentRole>[] = [
    { key: 'role', header: 'Role', render: (r) => <span className="capitalize">{ROLE_LABEL(r)}</span> },
    {
      key: 'tier',
      header: 'Model tier',
      width: '12rem',
      render: (r) => (
        <Select
          aria-label={`Tier for ${ROLE_LABEL(r)}`}
          value={draft.models.rolePolicy[r]}
          onChange={(tier) => set('models', { rolePolicy: { ...draft.models.rolePolicy, [r]: tier } })}
          options={MODEL_TIERS.map((t) => ({ value: t, label: TIER_LABEL[t] }))}
        />
      ),
    },
  ]

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {models.isPending ? <Loading label="Asking the runtime for available models" /> : null}
      {models.isError ? (
        <Notice tone="warning" title="Model list unavailable">
          The runtime did not report its models ({models.error.message}). Tiers can still be set to
          any alias or id already configured.
        </Notice>
      ) : null}
      <div>
        <h3 className="mb-2 mt-0 font-semibold">Tier to model</h3>
        <div className="flex flex-col gap-3">
          {MODEL_TIERS.map((t) => (
            <Field
              key={t}
              label={TIER_LABEL[t]}
              error={error(`models.tiers.${t}`)}
              hint={t === 'strongest' ? 'Planning, architecture, review, verification and debugging by default.' : undefined}
            >
              {(id) => (
                <Select
                  id={id}
                  data-testid={`tier-${t}`}
                  value={draft.models.tiers[t]}
                  onChange={(v) => set('models', { tiers: { ...draft.models.tiers, [t]: v } })}
                  options={options(draft.models.tiers[t])}
                />
              )}
            </Field>
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-2 mt-0 font-semibold">Role to tier policy</h3>
        <div className="border">
          <DataTable columns={columns} rows={AGENT_ROLES} rowKey={(r) => r} />
        </div>
        <p className="mb-0 mt-2 text-small text-text-muted">
          The ECO preset moves most roles one tier down at run time; this table is the BALANCED and
          MAXIMUM baseline.
        </p>
      </div>
    </div>
  )
}

export function ExecutionSection({ draft, set, error }: SectionProps) {
  const e = draft.execution
  const num = (label: string, key: keyof Settings['execution'], min: number, max: number, hint?: string) => (
    <Field label={label} hint={hint ?? `${min} to ${max}`} error={error(`execution.${key}`)}>
      {(id) => (
        <NumberField
          id={id}
          min={min}
          max={max}
          value={e[key] as number}
          onChange={(v) => set('execution', { [key]: v })}
          data-testid={`exec-${key}`}
        />
      )}
    </Field>
  )
  return (
    <Stack>
      <Field label="Default preset">
        {(id) => (
          <Select
            id={id}
            value={e.defaultPreset}
            onChange={(v) => set('execution', { defaultPreset: v })}
            options={PRESETS.map((p) => ({ value: p, label: p.toUpperCase() }))}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        {num('Max parallel agents (BALANCED)', 'maxParallelAgents', 1, 16, 'BALANCED uses at most 4')}
        {num('Max agents (MAXIMUM)', 'maximumPresetAgents', 1, 16)}
        {num('Max turns per agent', 'maxTurnsPerAgent', 1, 1000)}
        {num('Max retries per task', 'maxRetriesPerTask', 0, 10)}
        {num('Max run duration (minutes)', 'maxDurationMinutes', 1, 1440)}
        {num('Max repair iterations', 'maxIterations', 1, 50, 'Also the LOOP default')}
        {num('Rotate session after turns', 'sessionRotationTurns', 0, 1000, '0 disables rotation')}
        {num('Task lease (minutes)', 'leaseMinutes', 1, 240)}
        {num('Check timeout (minutes)', 'checkTimeoutMinutes', 1, 120)}
      </div>
      <Toggle
        checked={e.requirePlanApproval}
        onChange={(v) => set('execution', { requirePlanApproval: v })}
        label="Require plan approval by default"
      />
      <Field label="Execution profile" hint="How strictly NEXUS gates the commands and scripts agents run." error={error('execution.profile')}>
        {(id) => (
          <Select
            id={id}
            value={e.profile}
            onChange={(v) => set('execution', { profile: v })}
            options={[
              { value: 'STANDARD', label: 'Standard (recommended)' },
              { value: 'RESTRICTED', label: 'Restricted (more approvals)' },
            ]}
            data-testid="exec-profile"
          />
        )}
      </Field>
      <Notice tone="neutral" title="Neither profile is a sandbox" data-testid="exec-profile-note">
        {PROFILE_EXPLANATION}
      </Notice>
    </Stack>
  )
}

export function GitSection({ draft, set, error }: SectionProps) {
  return (
    <Stack>
      <Toggle
        checked={draft.git.removeWorktreesOnSuccess}
        onChange={(v) => set('git', { removeWorktreesOnSuccess: v })}
        label="Remove task worktrees after a successful merge"
        description="Branches are always kept. Worktrees can also be cleaned up per run."
      />
      <Field label="Commit author name" error={error('git.commitAuthorName')}>
        {(id) => <Input id={id} value={draft.git.commitAuthorName} onChange={(e) => set('git', { commitAuthorName: e.target.value })} />}
      </Field>
      <Field label="Commit author email" error={error('git.commitAuthorEmail')}>
        {(id) => <Input id={id} value={draft.git.commitAuthorEmail} onChange={(e) => set('git', { commitAuthorEmail: e.target.value })} />}
      </Field>
    </Stack>
  )
}

export function PermissionsSection({ draft, set }: SectionProps) {
  return (
    <Stack>
      <Toggle
        checked={draft.permissions.allowNetworkTools}
        onChange={(v) => set('permissions', { allowNetworkTools: v })}
        label="Allow web tools for read-only roles"
        description="Lets researchers and reviewers use WebFetch and WebSearch. Off by default."
      />
      <Field
        label="Safe command prefixes"
        hint="One per line. Shell commands starting with one of these never ask for approval, e.g. pnpm test. Add only commands you trust completely."
      >
        {(id) => (
          <Textarea
            id={id}
            rows={5}
            className="font-mono"
            value={draft.permissions.safeCommandPrefixes.join('\n')}
            onChange={(e) => set('permissions', { safeCommandPrefixes: e.target.value.split('\n') })}
            data-testid="safe-prefixes"
          />
        )}
      </Field>
    </Stack>
  )
}

export function MemorySection({ draft, set, error }: SectionProps) {
  return (
    <Stack>
      <Toggle
        checked={draft.memory.enabled}
        onChange={(v) => set('memory', { enabled: v })}
        label="Enable memory"
        description="Approved entries are added to agent context packs."
      />
      <Field label="Max entries per context" hint="0 to 50" error={error('memory.maxEntriesPerContext')}>
        {(id) => (
          <NumberField id={id} min={0} max={50} value={draft.memory.maxEntriesPerContext} onChange={(v) => set('memory', { maxEntriesPerContext: v })} />
        )}
      </Field>
      <Toggle
        checked={draft.memory.autoApproveVerifierMemory}
        onChange={(v) => set('memory', { autoApproveVerifierMemory: v })}
        label="Auto-approve memory proposed by the verifier"
        description="Everything else stays proposed until you approve it in the Memory view."
      />
    </Stack>
  )
}

const SWITCH: SelectOption<TechniqueSwitch>[] = [
  { value: 'auto', label: 'Automatic (the release default)' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]
const TECHNIQUE_FIELDS: { key: Technique; label: string; hint: string }[] = [
  { key: 'contextGraph', label: 'Context Graph in agent context', hint: 'Agents get the map of the project knowledge, what is related to their task, and tools to browse it.' },
  { key: 'outputFiltering', label: 'Failures first in check output', hint: 'Automatic adds the failures before the tail of a long output. On also shortens the output of passing runs. Off shows only the tail.' },
  { key: 'pressureRotation', label: 'Rotate sessions by context pressure', hint: 'A session that reaches its turn limit with a small context continues instead of being rotated.' },
  { key: 'stablePrefix', label: 'Stable system prefix', hint: 'Keeps the working directory out of the system prompt. Measured to make no difference to the cache on the Claude runtime.' },
  { key: 'toolLoading', label: 'Load the NEXUS tools upfront', hint: 'Instead of leaving their definitions behind tool search. Measured to make no difference to request size.' },
]

/** 0.7.1: context and token efficiency. Automatic turns a technique on only where the release's evidence supports it. */
export function TokensSection({ draft, set, error }: SectionProps) {
  return (
    <Stack>
      <p className="m-0 text-text-secondary">
        Quality first. None of these changes a model, an effort level, the number of agents or the
        number of reviews. Automatic follows the release default:{' '}
        {TECHNIQUE_FIELDS.filter((t) => AUTO_DEFAULTS[t.key]).map((t) => t.label.toLowerCase()).join(', ') || 'none'}{' '}
        on, the rest off.
      </p>
      {TECHNIQUE_FIELDS.map((t) => (
        <Field key={t.key} label={t.label} hint={t.hint}>
          {(id) => <Select id={id} data-testid={`tokens-${t.key}`} value={draft.tokens[t.key]} onChange={(v) => set('tokens', { [t.key]: v })} options={SWITCH} />}
        </Field>
      ))}
      <Field label="Context breakdown" hint="How each session's context is measured at the end of a turn. Full asks the runtime to count every category, which makes extra token-count requests.">
        {(id) => (
          <Select
            id={id}
            data-testid="tokens-contextUsageDetail"
            value={draft.tokens.contextUsageDetail}
            onChange={(v) => set('tokens', { contextUsageDetail: v })}
            options={[
              { value: 'summary', label: "Summary (the runtime's estimate)" },
              { value: 'full', label: 'Full (counted by the runtime)' },
              { value: 'off', label: 'Off' },
            ]}
          />
        )}
      </Field>
      <Field label="Graph context budget (tokens)" hint="200 to 20,000. Advisory: retrieval goes over it for high-risk or cross-cutting work." error={error('tokens.graphContextBudget')}>
        {(id) => <NumberField id={id} min={200} max={20000} value={draft.tokens.graphContextBudget} onChange={(v) => set('tokens', { graphContextBudget: v })} />}
      </Field>
    </Stack>
  )
}

const MCP_TYPES: SelectOption<McpServerSetting['type']>[] = [
  { value: 'stdio', label: 'stdio (local process)' },
  { value: 'http', label: 'http' },
  { value: 'sse', label: 'sse' },
]
const EMPTY_MCP: McpDraft = { name: '', type: 'stdio', command: '', args: '', url: '' }

export function McpSection({ draft, set }: SectionProps) {
  const servers = draft.mcp.servers
  const [form, setForm] = useState<McpDraft>(EMPTY_MCP)
  const [formError, setFormError] = useState<string | null>(null)

  const update = (name: string, patch: Partial<McpServerSetting>) =>
    set('mcp', { servers: servers.map((s) => (s.name === name ? { ...s, ...patch } : s)) })
  const toggleRole = (s: McpServerSetting, role: AgentRole) =>
    update(s.name, { roles: s.roles.includes(role) ? s.roles.filter((r) => r !== role) : [...s.roles, role] })

  const add = () => {
    const result = buildMcpServer(form, servers)
    if (!result.ok) return setFormError(result.error)
    setFormError(null)
    set('mcp', { servers: [...servers, result.server] })
    setForm(EMPTY_MCP)
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Notice tone="neutral" title="Nothing is installed automatically">
        Servers listed here are only configuration. A server runs only when it is enabled and only
        for the roles you grant. A stdio server is a local process started with your user
        permissions: add only software you trust.
      </Notice>

      {servers.length === 0 ? <div className="text-fg-muted">No MCP servers configured.</div> : null}
      {servers.map((s) => (
        <div key={s.name} data-testid={`mcp-${s.name}`} className={cn('rounded-lg border bg-surface p-3', s.enabled && 'border-success/40')}>
          <div className="flex items-center gap-2">
            <span className="font-mono font-medium">{s.name}</span>
            <Badge mono>{s.type}</Badge>
            <span className="ml-2 min-w-0 flex-1 truncate font-mono text-[0.88em] text-fg-muted">
              {s.type === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url}
            </span>
            <Toggle checked={s.enabled} onChange={(v) => update(s.name, { enabled: v })} aria-label={`Enable ${s.name}`} data-testid={`mcp-enable-${s.name}`} />
            <IconButton label={`Remove ${s.name}`} onClick={() => set('mcp', { servers: servers.filter((x) => x.name !== s.name) })}>
              <TrashIcon />
            </IconButton>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="mr-1 text-fg-muted">Role access</span>
            {AGENT_ROLES.map((r) => {
              const on = s.roles.includes(r)
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleRole(s, r)}
                  className={cn(
                    'rounded-md border px-2 text-small capitalize',
                    on ? 'border-accent/40 bg-accent-subtle text-accent' : 'border-border-strong text-text-secondary hover:bg-surface-hover',
                  )}
                >
                  {ROLE_LABEL(r)}
                </button>
              )
            })}
            {s.roles.length === 0 ? <span className="ml-1 text-fg-faint">no role can use this server</span> : null}
          </div>
        </div>
      ))}

      <div className="border p-3">
        <h3 className="mb-2 mt-0 font-semibold">Add server</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            {(id) => <Input id={id} value={form.name} placeholder="github" onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="mcp-name" />}
          </Field>
          <Field label="Type">
            {(id) => <Select id={id} value={form.type} onChange={(type) => setForm({ ...form, type })} options={MCP_TYPES} />}
          </Field>
          {form.type === 'stdio' ? <>
              <Field label="Command">
                {(id) => <Input id={id} className="font-mono" value={form.command} placeholder="npx" onChange={(e) => setForm({ ...form, command: e.target.value })} />}
              </Field>
              <Field label="Arguments" hint="One per line">
                {(id) => <Textarea id={id} rows={3} className="font-mono" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />}
              </Field>
            </> : (
            <Field label="URL" className="col-span-2">
              {(id) => <Input id={id} className="font-mono" value={form.url} placeholder="https://" onChange={(e) => setForm({ ...form, url: e.target.value })} />}
            </Field>
          )}
        </div>
        {formError ? <ErrorNote error={formError} className="mt-2" /> : null}
        <div className="mt-3 flex justify-end">
          <Button icon={<PlusIcon size={12} />} onClick={add} data-testid="mcp-add">
            Add (disabled until you enable it)
          </Button>
        </div>
      </div>
    </div>
  )
}

export function AppearanceSection({ draft, set }: SectionProps) {
  const a = draft.appearance
  return (
    <Stack>
      <p className="m-0 text-text-secondary">Changes preview immediately. Save to keep them.</p>
      <Field label="Theme">
        {(id) => (
          <Select
            id={id}
            data-testid="theme-select"
            value={a.theme}
            onChange={(v) => set('appearance', { theme: v })}
            options={[
              { value: 'light', label: 'Light (default)' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        )}
      </Field>
      <Field label="Density" hint="Compact fits more rows; comfortable adds space around controls and rows.">
        {(id) => (
          <Select
            id={id}
            data-testid="density-select"
            value={a.density}
            onChange={(v) => set('appearance', { density: v })}
            options={[
              { value: 'compact', label: 'Compact (default)' },
              { value: 'comfortable', label: 'Comfortable' },
            ]}
          />
        )}
      </Field>
      <Field label={`Font size: ${a.fontSize}px`} hint="10 to 20">
        {(id) => (
          <input
            id={id}
            type="range"
            min={10}
            max={20}
            step={1}
            value={a.fontSize}
            onChange={(e) => set('appearance', { fontSize: Number(e.target.value) })}
            className="w-full max-w-xs"
          />
        )}
      </Field>
    </Stack>
  )
}

/** Usage behavior: how NEXUS waits for and resumes after a Claude usage limit. Nothing here implies a quota NEXUS cannot measure. */
export function UsageSection({ draft, set, error }: SectionProps) {
  const u = draft.usage
  const patch = (p: Partial<Settings['usage']>) => set('usage', p)
  return (
    <Stack>
      <p className="m-0 text-text-secondary">
        When Claude reports a usage limit, NEXUS pauses the affected missions, keeps their work, and
        resumes them when Claude is available again.
      </p>
      <Toggle
        checked={u.autoResume}
        onChange={(v) => patch({ autoResume: v })}
        label="Auto resume after reset"
        description="Resume paused missions by themselves once Claude is available. Off: you resume them."
        data-testid="usage-auto-resume"
      />
      <Field
        label="Resume delay (seconds)"
        hint="Wait this long after a reset Claude reported before checking availability."
        error={error('usage.resumeDelaySeconds')}
      >
        {(id) => <NumberField id={id} min={15} max={3600} value={u.resumeDelaySeconds} onChange={(v) => patch({ resumeDelaySeconds: v })} className="max-w-40" data-testid="usage-resume-delay" />}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Unknown-reset probe interval (minutes)"
          hint="When no reset time is reported, availability is checked at this interval, doubling up to the maximum."
          error={error('usage.unknownResetProbeMinutes')}
        >
          {(id) => <NumberField id={id} min={5} max={240} value={u.unknownResetProbeMinutes} onChange={(v) => patch({ unknownResetProbeMinutes: v })} data-testid="usage-probe-minutes" />}
        </Field>
        <Field label="Maximum probe interval (minutes)" error={error('usage.unknownResetProbeMaxMinutes')}>
          {(id) => <NumberField id={id} min={5} max={720} value={u.unknownResetProbeMaxMinutes} onChange={(v) => patch({ unknownResetProbeMaxMinutes: v })} data-testid="usage-probe-max-minutes" />}
        </Field>
      </div>
      <Field
        label="Maximum quota wait (minutes)"
        hint="0 inherits the mission deadline: NEXUS sets no limit of its own."
        error={error('usage.maxQuotaWaitMinutes')}
      >
        {(id) => <NumberField id={id} min={0} max={10080} value={u.maxQuotaWaitMinutes} onChange={(v) => patch({ maxQuotaWaitMinutes: v })} className="max-w-40" data-testid="usage-max-wait" />}
      </Field>
      <Toggle
        checked={u.pauseAllOnGlobalLimit}
        onChange={(v) => patch({ pauseAllOnGlobalLimit: v })}
        label="Pause all Claude dispatch on global limit"
        description="One limit holds every mission, not only the one that hit it."
        data-testid="usage-pause-all"
      />
      <Toggle
        checked={u.notifyOnResume}
        onChange={(v) => patch({ notifyOnResume: v })}
        label="Notify when resumed"
        data-testid="usage-notify"
      />
      <Toggle
        checked={u.overnightWaitForReset}
        onChange={(v) => patch({ overnightWaitForReset: v })}
        label="In Overnight: wait for reset if before mission deadline"
        description="Otherwise an Overnight mission ends when it hits a usage limit."
        data-testid="usage-overnight-wait"
      />
      <Toggle
        checked={u.useRuntimeUsageReport}
        onChange={(v) => patch({ useRuntimeUsageReport: v })}
        label="Use the runtime's usage report"
        description="An experimental Claude runtime feature. If it is not available, NEXUS falls back to conservative probing."
        data-testid="usage-runtime-report"
      />
    </Stack>
  )
}

export function AdvancedSection({ draft, set }: SectionProps) {
  const info = useAppInfo()
  const openDir = useOpenDataDir()
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Toggle
        checked={draft.advanced.debugSdk}
        onChange={(v) => set('advanced', { debugSdk: v })}
        label="Debug SDK"
        description="Verbose Claude SDK diagnostics in the main-process log."
      />
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="m-0 font-semibold">Data and environment</h3>
          <Button size="sm" loading={openDir.isPending} onClick={() => openDir.mutate({})} data-testid="open-data-dir">
            Open data folder
          </Button>
        </div>
        {info.isPending ? <Loading /> : null}
        {info.isError ? <ErrorNote error={info.error} /> : null}
        {info.data ? (
          <KeyValue
            rows={[
              { label: 'Data directory', value: info.data.dataDir, mono: true },
              { label: 'Database', value: info.data.dbPath, mono: true },
              { label: 'Worktrees', value: info.data.worktreesDir, mono: true },
              { label: 'NEXUS version', value: info.data.version, mono: true },
              {
                label: 'Build commit',
                value: info.data.build
                  ? `${info.data.build.commit}${info.data.build.dirty ? ' (modified sources)' : ''}`
                  : 'Unknown',
                mono: true,
              },
              { label: 'Built at', value: info.data.build?.builtAt ?? 'Unknown', mono: true },
              { label: 'Channel', value: info.data.build?.channel ?? 'Unknown' },
              {
                label: 'Runtime protocol',
                value: String(info.data.build?.runtimeProtocol ?? 'Unknown'),
                mono: true,
              },
              {
                label: 'Database schema',
                value: String(info.data.build?.databaseSchema ?? 'Unknown'),
                mono: true,
              },
              { label: 'Claude SDK', value: info.data.sdkVersion, mono: true },
              { label: 'Git', value: info.data.gitVersion ?? 'not found', mono: true },
              { label: 'Platform', value: info.data.platform, mono: true },
              { label: 'Packaged', value: info.data.isPackaged ? 'yes' : 'no (development)' },
            ]}
          />
        ) : null}
        <p className="mb-0 mt-2 text-small text-text-muted">
          Worktrees live under the data directory, never inside your repository. If one is removed
          by hand, run <InlineCode>git worktree prune</InlineCode> in the repository.
        </p>
      </div>
    </div>
  )
}
