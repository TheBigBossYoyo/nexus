import { ProviderIdSchema, type ProviderId, type ProviderSession } from '@shared/provider'
import type { Database } from '../database'
import { prepare, Table, type Codec } from '../table'

const sessionCodec: Codec<ProviderSession> = {
  table: 'provider_sessions',
  fields: {
    id: 'text',
    runId: 'text',
    agentId: 'text',
    role: 'text',
    label: 'text',
    requested: 'text',
    provider: 'text',
    model: 'text',
    runtimeVersion: 'text',
    authMode: 'text',
    reason: 'text',
    fallbackReason: 'text',
    sessionId: 'text',
    outcome: 'text',
    error: 'text',
    inputTokens: 'num',
    outputTokens: 'num',
    createdAt: 'text',
    endedAt: 'text',
  },
}

/** v0.6: which provider ran each agent session, and why. */
export class ProviderSessionStore extends Table<ProviderSession> {
  constructor(db: Database) {
    super(db, sessionCodec, 'provider session')
  }

  listRecent(limit = 200): ProviderSession[] {
    return this.query('ORDER BY created_at DESC, rowid DESC LIMIT ?', [Math.min(Math.max(1, limit), 1000)])
  }

  listByRun(runId: string): ProviderSession[] {
    return this.query('WHERE run_id = ? ORDER BY created_at, rowid', [runId])
  }

  /** The provider that owns a session id, so a resumed session goes back to it. */
  providerOfSession(sessionId: string): ProviderId | null {
    const row = prepare(this.db, 'SELECT provider FROM provider_sessions WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(sessionId) as { provider: string } | undefined
    const parsed = ProviderIdSchema.safeParse(row?.provider)
    return parsed.success ? parsed.data : null
  }

  /** The provider of an agent's newest session, or null when none is recorded. */
  latestProviderOfAgent(agentId: string): ProviderId | null {
    const row = prepare(this.db, 'SELECT provider FROM provider_sessions WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(agentId) as { provider: string } | undefined
    const parsed = ProviderIdSchema.safeParse(row?.provider)
    return parsed.success ? parsed.data : null
  }

  /** Sessions that were running when NEXUS stopped did not end with a result. */
  closeInterrupted(at: string): number {
    return prepare(this.db, "UPDATE provider_sessions SET outcome = 'failed', error = 'NEXUS stopped while the session was running.', ended_at = ? WHERE outcome = 'running'").run(at).changes
  }
}
