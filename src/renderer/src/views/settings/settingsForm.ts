import { McpServerSettingSchema, SettingsSchema, type McpServerSetting, type Settings } from '@shared/settings'

/** Trim free-text fields and drop blank list entries so what is validated is what is saved. */
export function normalizeSettings(s: Settings): Settings {
  return {
    ...s,
    claude: { ...s.claude, executablePath: s.claude.executablePath.trim() },
    git: {
      ...s.git,
      commitAuthorName: s.git.commitAuthorName.trim(),
      commitAuthorEmail: s.git.commitAuthorEmail.trim(),
    },
    permissions: {
      ...s.permissions,
      safeCommandPrefixes: s.permissions.safeCommandPrefixes.map((p) => p.trim()).filter((p) => p.length > 0),
    },
  }
}

export type SettingsValidation =
  | { ok: true; settings: Settings }
  | { ok: false; errors: Record<string, string> }

/** Validates with the same SettingsSchema main uses. Errors are keyed by dotted path, e.g. "execution.maxIterations". */
export function validateSettings(draft: Settings): SettingsValidation {
  const parsed = SettingsSchema.safeParse(normalizeSettings(draft))
  if (parsed.success) return { ok: true, settings: parsed.data }
  const errors: Record<string, string> = {}
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.')
    errors[key] ??= issue.message
  }
  return { ok: false, errors }
}

export function isSameSettings(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface McpDraft {
  name: string
  type: McpServerSetting['type']
  command: string
  /** One argument per line. */
  args: string
  url: string
}

export type McpDraftResult = { ok: true; server: McpServerSetting } | { ok: false; error: string }

/** Builds a new, disabled server entry with no role access: nothing is enabled implicitly. */
export function buildMcpServer(draft: McpDraft, existing: readonly McpServerSetting[]): McpDraftResult {
  const name = draft.name.trim()
  if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `A server named "${name}" already exists.` }
  }
  const command = draft.command.trim()
  const url = draft.url.trim()
  if (draft.type === 'stdio' && !command) return { ok: false, error: 'A stdio server needs a command.' }
  if (draft.type !== 'stdio' && !url) return { ok: false, error: 'An http or sse server needs a URL.' }
  const server: McpServerSetting = {
    name,
    type: draft.type,
    enabled: false,
    roles: [],
    ...(draft.type === 'stdio'
      ? {
          command,
          args: draft.args
            .split(/\r?\n/)
            .map((a) => a.trim())
            .filter((a) => a.length > 0),
        }
      : { url }),
  }
  const parsed = McpServerSettingSchema.safeParse(server)
  if (!parsed.success) {
    return { ok: false, error: 'Name may only contain letters, digits, "_" and "-".' }
  }
  return { ok: true, server: parsed.data }
}
