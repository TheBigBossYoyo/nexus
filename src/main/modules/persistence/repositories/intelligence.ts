import { randomUUID } from 'node:crypto'
import type { Database } from '../database'
import type { CompiledTaskSpec, DirectorInvocation, UserIntentMetadata } from '@shared/intelligence'
import type { AdmissionKind } from '@main/modules/intelligence/admission'

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
  saveIntent(projectId: string, raw: string, metadata?: UserIntentMetadata): string {
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO raw_user_intents(id,project_id,raw_text,created_at,metadata) VALUES (?,?,?,?,?)',
      )
      .run(id, projectId, raw, new Date().toISOString(), JSON.stringify(metadata ?? {}))
    return id
  }
  private hydrateCompilation(body: string, intentId: string | null): CompiledTaskSpec {
    const spec = JSON.parse(body) as CompiledTaskSpec
    if (!intentId) return spec
    const intent = this.db
      .prepare('SELECT raw_text,metadata FROM raw_user_intents WHERE id=?')
      .get(intentId) as { raw_text: string; metadata: string } | undefined
    if (!intent) throw new Error('Canonical compilation intent is missing')
    const metadata = JSON.parse(intent.metadata) as Partial<UserIntentMetadata>
    const refs = this.db
      .prepare(
        'SELECT context_id AS id,context_version AS version FROM compilation_context_refs WHERE artifact_id=? ORDER BY context_id',
      )
      .all(spec.id) as { id: string; version: string }[]
    return {
      ...spec,
      rawIntent: intent.raw_text,
      intentId,
      ...(metadata.entryPoint ? { userMetadata: metadata as UserIntentMetadata } : {}),
      dependencies: refs.length ? refs : (spec.dependencies ?? []),
    }
  }
  bindAdmission(kind: AdmissionKind, entityId: string, spec: CompiledTaskSpec): void {
    if (spec.status !== 'READY' || !this.compilation(spec.projectId, spec.id))
      throw new Error('Admission requires a saved ready specification')
    this.db
      .prepare(
        'INSERT INTO engineering_admissions(kind,entity_id,project_id,spec_id) VALUES (?,?,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET project_id=excluded.project_id,spec_id=excluded.spec_id',
      )
      .run(kind, entityId, spec.projectId, spec.id)
    this.db.prepare('INSERT OR IGNORE INTO engineering_admission_history(kind,entity_id,project_id,spec_id) VALUES (?,?,?,?)')
      .run(kind, entityId, spec.projectId, spec.id)
  }
  admissionHistory(kind: AdmissionKind, entityId: string): CompiledTaskSpec[] {
    const rows = this.db.prepare('SELECT project_id,spec_id FROM engineering_admission_history WHERE kind=? AND entity_id=? ORDER BY ordinal')
      .all(kind, entityId) as { project_id: string; spec_id: string }[]
    return rows.map(r => this.compilation(r.project_id, r.spec_id)).filter((s): s is CompiledTaskSpec => s !== null)
  }
  admission(kind: AdmissionKind, entityId: string): CompiledTaskSpec | null {
    const row = this.db
      .prepare('SELECT project_id,spec_id FROM engineering_admissions WHERE kind=? AND entity_id=?')
      .get(kind, entityId) as { project_id: string; spec_id: string } | undefined
    return row ? this.compilation(row.project_id, row.spec_id) : null
  }
  reusableCompilation(projectId: string, identity: string): CompiledTaskSpec | null {
    const row = this.db
      .prepare(
        "SELECT body,intent_id FROM intelligence_artifacts WHERE project_id=? AND kind='compilation' AND identity=?",
      )
      .get(projectId, identity) as { body: string; intent_id: string | null } | undefined
    if (!row) return null
    const spec = this.hydrateCompilation(row.body, row.intent_id)
    return spec.status === 'WAITING_FOR_PROVIDER' ? null : spec
  }
  saveCompilation(spec: CompiledTaskSpec, savedIntentId?: string): CompiledTaskSpec {
    return this.db.transaction(() => {
      if (savedIntentId) {
        const intent = this.db
          .prepare('SELECT project_id,raw_text,metadata FROM raw_user_intents WHERE id=?')
          .get(savedIntentId) as
          { project_id: string; raw_text: string; metadata: string } | undefined
        if (
          !intent ||
          intent.project_id !== spec.projectId ||
          intent.raw_text !== spec.rawIntent ||
          intent.metadata !== JSON.stringify(spec.userMetadata ?? {})
        )
          throw new Error('Compilation does not match its saved user intent')
      }
      const existing = this.db
        .prepare(
          "SELECT body,intent_id FROM intelligence_artifacts WHERE project_id=? AND kind='compilation' AND identity=?",
        )
        .get(spec.projectId, spec.identity) as
        { body: string; intent_id: string | null } | undefined
      if (existing) {
        const prior = this.hydrateCompilation(existing.body, existing.intent_id)
        if (prior.status !== 'WAITING_FOR_PROVIDER') return prior
        // Waiting is an attempt, not a reusable compilation. Keep its history under its unique ID.
        this.db
          .prepare('UPDATE intelligence_artifacts SET identity=? WHERE id=?')
          .run(`waiting:${prior.id}`, prior.id)
      }
      const intentId =
        savedIntentId ?? this.saveIntent(spec.projectId, spec.rawIntent, spec.userMetadata)
      // One immutable intent and one reference relation are the durable truth. Hydrate old
      // snapshot-based records for compatibility; new artifacts avoid duplicating that data.
      const {
        rawIntent: _raw,
        dependencies: _refs,
        userMetadata: _metadata,
        intentId: _intent,
        ...body
      } = spec
      this.db
        .prepare(
          "INSERT INTO intelligence_artifacts(id,project_id,intent_id,kind,identity,body,created_at) VALUES (?,?,?,'compilation',?,?,?)",
        )
        .run(spec.id, spec.projectId, intentId, spec.identity, JSON.stringify(body), spec.createdAt)
      const put = this.db.prepare(
        'INSERT INTO compilation_context_refs(artifact_id,context_id,context_version) VALUES (?,?,?)',
      )
      for (const ref of spec.dependencies) put.run(spec.id, ref.id, ref.version)
      return this.hydrateCompilation(JSON.stringify(body), intentId)
    })()
  }
  listCompilations(projectId: string, offset = 0): CompiledTaskSpec[] {
    const rows = this.db
      .prepare(
        "SELECT body,intent_id FROM intelligence_artifacts WHERE project_id=? AND kind='compilation' ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?",
      )
      .all(projectId, Math.max(0, Math.floor(offset))) as {
      body: string
      intent_id: string | null
    }[]
    return rows.map((r) => this.hydrateCompilation(r.body, r.intent_id))
  }
  compilation(projectId: string, id: string): CompiledTaskSpec | null {
    const row = this.db
      .prepare(
        "SELECT body,intent_id FROM intelligence_artifacts WHERE project_id=? AND id=? AND kind='compilation'",
      )
      .get(projectId, id) as { body: string; intent_id: string | null } | undefined
    return row ? this.hydrateCompilation(row.body, row.intent_id) : null
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
