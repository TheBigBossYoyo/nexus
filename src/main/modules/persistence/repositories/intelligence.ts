import { randomUUID } from 'node:crypto'
import type { Database } from '../database'
import type { CompiledTaskSpec, DirectorInvocation } from '@shared/intelligence'

export class IntelligenceStore {
  constructor(private readonly db: Database) {}
  reconcileInterrupted(): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT id,body FROM intelligence_artifacts WHERE kind='director'")
        .all() as { id: string; body: string }[]
      let changed = 0
      for (const row of rows) {
        const invocation = JSON.parse(row.body) as DirectorInvocation
        if (invocation.state !== 'PENDING') continue
        invocation.state = 'FAILED'
        invocation.message =
          'Runtime stopped before the outcome was saved. Provider consumption is unknown. Review the saved request before explicitly retrying; it was not replayed automatically.'
        invocation.updatedAt = new Date().toISOString()
        changed += this.db
          .prepare('UPDATE intelligence_artifacts SET body=? WHERE id=?')
          .run(JSON.stringify(invocation), row.id).changes
      }
      return changed
    })()
  }
  saveDirector(invocation: DirectorInvocation, intentId: string): void {
    const intent = this.db
      .prepare('SELECT project_id,raw_text FROM raw_user_intents WHERE id=?')
      .get(intentId) as { project_id: string; raw_text: string } | undefined
    if (
      !intent ||
      intent.project_id !== invocation.projectId ||
      intent.raw_text !== invocation.objective
    )
      throw new Error('Director invocation does not match its saved intent')
    this.db
      .prepare(
        "INSERT INTO intelligence_artifacts(id,project_id,intent_id,kind,identity,body,created_at) VALUES (?,?,?,'director',?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE project_id=excluded.project_id AND intent_id=excluded.intent_id AND kind='director'",
      )
      .run(
        invocation.id,
        invocation.projectId,
        intentId,
        invocation.id,
        JSON.stringify(invocation),
        invocation.createdAt,
      )
  }
  listDirectors(projectId: string, offset = 0): DirectorInvocation[] {
    const rows = this.db
      .prepare(
        "SELECT body FROM intelligence_artifacts WHERE project_id=? AND kind='director' ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?",
      )
      .all(projectId, Math.max(0, Math.floor(offset))) as { body: string }[]
    return rows.map((r) => JSON.parse(r.body) as DirectorInvocation)
  }
  saveIntent(projectId: string, raw: string): string {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO raw_user_intents(id,project_id,raw_text,created_at) VALUES (?,?,?,?)')
      .run(id, projectId, raw, new Date().toISOString())
    return id
  }
  reusableCompilation(projectId: string, identity: string): CompiledTaskSpec | null {
    const row = this.db
      .prepare(
        "SELECT body FROM intelligence_artifacts WHERE project_id=? AND kind='compilation' AND identity=?",
      )
      .get(projectId, identity) as { body: string } | undefined
    if (!row) return null
    const spec = JSON.parse(row.body) as CompiledTaskSpec
    return spec.status === 'WAITING_FOR_PROVIDER' ? null : spec
  }
  saveCompilation(spec: CompiledTaskSpec, savedIntentId?: string): CompiledTaskSpec {
    return this.db.transaction(() => {
      if (savedIntentId) {
        const intent = this.db
          .prepare('SELECT project_id,raw_text FROM raw_user_intents WHERE id=?')
          .get(savedIntentId) as { project_id: string; raw_text: string } | undefined
        if (!intent || intent.project_id !== spec.projectId || intent.raw_text !== spec.rawIntent)
          throw new Error('Compilation does not match its saved user intent')
      }
      const existing = this.db
        .prepare(
          "SELECT body FROM intelligence_artifacts WHERE project_id=? AND kind='compilation' AND identity=?",
        )
        .get(spec.projectId, spec.identity) as { body: string } | undefined
      if (existing) {
        const prior = JSON.parse(existing.body) as CompiledTaskSpec
        if (prior.status !== 'WAITING_FOR_PROVIDER') return prior
        // Waiting is an attempt, not a reusable compilation. Keep its history under its unique ID.
        this.db
          .prepare('UPDATE intelligence_artifacts SET identity=? WHERE id=?')
          .run(`waiting:${prior.id}`, prior.id)
      }
      const intentId = savedIntentId ?? this.saveIntent(spec.projectId, spec.rawIntent)
      this.db
        .prepare(
          "INSERT INTO intelligence_artifacts(id,project_id,intent_id,kind,identity,body,created_at) VALUES (?,?,?,'compilation',?,?,?)",
        )
        .run(spec.id, spec.projectId, intentId, spec.identity, JSON.stringify(spec), spec.createdAt)
      return structuredClone(spec)
    })()
  }
  listCompilations(projectId: string, offset = 0): CompiledTaskSpec[] {
    const rows = this.db
      .prepare(
        "SELECT body FROM intelligence_artifacts WHERE project_id=? AND kind='compilation' ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?",
      )
      .all(projectId, Math.max(0, Math.floor(offset))) as { body: string }[]
    return rows.map((r) => JSON.parse(r.body) as CompiledTaskSpec)
  }
  compilation(projectId: string, id: string): CompiledTaskSpec | null {
    const row = this.db
      .prepare(
        "SELECT body FROM intelligence_artifacts WHERE project_id=? AND id=? AND kind='compilation'",
      )
      .get(projectId, id) as { body: string } | undefined
    return row ? (JSON.parse(row.body) as CompiledTaskSpec) : null
  }
  /** Compare-and-swap checkpoints prevent two controllers claiming the same recovery step. */
  checkpoint(id: string, expectedRevision: number | null, body: unknown): boolean {
    const json = JSON.stringify(body)
    if (json.length > 128000) throw new Error('Checkpoint exceeds durable record limit')
    if (expectedRevision === null)
      return (
        this.db
          .prepare('INSERT OR IGNORE INTO capacity_checkpoints(id,body,updated_at) VALUES (?,?,?)')
          .run(id, json, new Date().toISOString()).changes === 1
      )
    return (
      this.db
        .prepare(
          'UPDATE capacity_checkpoints SET body=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?',
        )
        .run(json, new Date().toISOString(), id, expectedRevision).changes === 1
    )
  }
  readCheckpoint(id: string): { body: unknown; revision: number } | null {
    const row = this.db
      .prepare('SELECT body,revision FROM capacity_checkpoints WHERE id=?')
      .get(id) as { body: string; revision: number } | undefined
    return row ? { body: JSON.parse(row.body), revision: row.revision } : null
  }
}
