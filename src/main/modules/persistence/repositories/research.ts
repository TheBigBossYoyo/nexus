import type { FreshnessPolicy, ResearchArtifact, ResearchBackend, ResearchScreening, SourceAuthority, SourceType } from '@shared/research'
import type { Database } from '../database'
import { guard, prepare, type Row } from '../table'

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

function artifactOf(row: Row): ResearchArtifact {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    runId: text(row['run_id']),
    taskId: text(row['task_id']),
    url: String(row['url']),
    canonicalUrl: String(row['canonical_url']),
    redirectChain: JSON.parse(String(row['redirect_chain'])) as string[],
    title: text(row['title']),
    retrievedAt: String(row['retrieved_at']),
    contentHash: String(row['content_hash']),
    contentType: text(row['content_type']),
    bytes: Number(row['bytes']),
    backend: String(row['backend']) as ResearchBackend,
    sourceType: String(row['source_type']) as SourceType,
    authority: String(row['authority']) as SourceAuthority,
    publisher: String(row['publisher']),
    freshness: String(row['freshness']) as FreshnessPolicy,
    staleAfter: String(row['stale_after']),
    trust: 'UNTRUSTED_WEB_CONTENT',
    screening: JSON.parse(String(row['screening'])) as ResearchScreening,
    summary: String(row['summary']),
    textChars: Number(row['text_chars']),
    truncated: Number(row['truncated']) !== 0,
    query: text(row['query']),
    textPath: text(row['text_path']),
  }
}

/** 0.8: what was read on the public web, one row per fetch that produced a text. */
export class ResearchArtifactRepository {
  constructor(private readonly db: Database) {}

  insert(a: ResearchArtifact): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO research_artifacts (id, project_id, run_id, task_id, url, canonical_url, redirect_chain, title, retrieved_at, content_hash, content_type, bytes, backend, source_type, authority, publisher, freshness, stale_after, trust, screening, summary, text_chars, truncated, query, text_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        a.id, a.projectId, a.runId, a.taskId, a.url, a.canonicalUrl, JSON.stringify(a.redirectChain), a.title, a.retrievedAt, a.contentHash, a.contentType, a.bytes, a.backend, a.sourceType, a.authority,
        a.publisher, a.freshness, a.staleAfter, a.trust, JSON.stringify(a.screening), a.summary, a.textChars, a.truncated ? 1 : 0, a.query, a.textPath,
      ),
    )
  }

  get(id: string): ResearchArtifact | null {
    const row = prepare(this.db, 'SELECT * FROM research_artifacts WHERE id = ?').get(id) as Row | undefined
    return row ? artifactOf(row) : null
  }

  /** The newest artifact of a page in a project that is not stale at `now`: research memory. */
  fresh(projectId: string, canonicalUrl: string, now: string): ResearchArtifact | null {
    const row = prepare(this.db, 'SELECT * FROM research_artifacts WHERE project_id = ? AND canonical_url = ? AND stale_after > ? AND text_path IS NOT NULL ORDER BY retrieved_at DESC LIMIT 1').get(projectId, canonicalUrl, now) as Row | undefined
    return row ? artifactOf(row) : null
  }

  list(opts: { projectId: string; runId?: string; taskId?: string; limit?: number }): ResearchArtifact[] {
    const where = ['project_id = ?']
    const params: (string | number)[] = [opts.projectId]
    if (opts.runId !== undefined) {
      where.push('run_id = ?')
      params.push(opts.runId)
    }
    if (opts.taskId !== undefined) {
      where.push('task_id = ?')
      params.push(opts.taskId)
    }
    const rows = prepare(this.db, `SELECT * FROM research_artifacts WHERE ${where.join(' AND ')} ORDER BY retrieved_at DESC, rowid DESC LIMIT ?`).all(...params, Math.min(Math.max(1, opts.limit ?? 50), 200)) as Row[]
    return rows.map(artifactOf)
  }

  countForRun(runId: string): number {
    return (prepare(this.db, 'SELECT COUNT(*) AS n FROM research_artifacts WHERE run_id = ?').get(runId) as { n: number }).n
  }

  /** Text files that no row names any more may be deleted; this lists the ones that are named. */
  textPaths(): string[] {
    return (prepare(this.db, 'SELECT text_path FROM research_artifacts WHERE text_path IS NOT NULL').all() as { text_path: string }[]).map((r) => r.text_path)
  }
}

export interface ResearchDownloadRow {
  id: string
  projectId: string
  runId: string | null
  taskId: string | null
  url: string
  finalUrl: string
  sha256: string
  mime: string | null
  /** What the first bytes say the file is, whatever its name and its declared type say. */
  sniffed: string
  bytes: number
  suggestedName: string | null
  downloadedAt: string
  state: 'QUARANTINED' | 'REFUSED' | 'RELEASED' | 'REMOVED'
  refusal: string | null
  quarantinePath: string | null
}

/** 0.8: files fetched from the public web, each held in quarantine or refused, with what is known of it. */
export class ResearchDownloadRepository {
  constructor(private readonly db: Database) {}

  insert(d: ResearchDownloadRow): void {
    guard(() =>
      prepare(
        this.db,
        `INSERT INTO research_downloads (id, project_id, run_id, task_id, url, final_url, sha256, mime, sniffed, bytes, suggested_name, downloaded_at, state, refusal, quarantine_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(d.id, d.projectId, d.runId, d.taskId, d.url, d.finalUrl, d.sha256, d.mime, d.sniffed, d.bytes, d.suggestedName, d.downloadedAt, d.state, d.refusal, d.quarantinePath),
    )
  }

  get(id: string): ResearchDownloadRow | null {
    const row = prepare(this.db, 'SELECT * FROM research_downloads WHERE id = ?').get(id) as Row | undefined
    return row ? downloadOf(row) : null
  }

  setState(id: string, state: ResearchDownloadRow['state']): boolean {
    return guard(() => prepare(this.db, 'UPDATE research_downloads SET state = ? WHERE id = ?').run(state, id)).changes > 0
  }

  list(opts: { projectId: string; runId?: string; limit?: number }): ResearchDownloadRow[] {
    const rows = (opts.runId !== undefined
      ? prepare(this.db, 'SELECT * FROM research_downloads WHERE project_id = ? AND run_id = ? ORDER BY downloaded_at DESC LIMIT ?').all(opts.projectId, opts.runId, opts.limit ?? 100)
      : prepare(this.db, 'SELECT * FROM research_downloads WHERE project_id = ? ORDER BY downloaded_at DESC LIMIT ?').all(opts.projectId, opts.limit ?? 100)) as Row[]
    return rows.map(downloadOf)
  }
}

function downloadOf(row: Row): ResearchDownloadRow {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    runId: text(row['run_id']),
    taskId: text(row['task_id']),
    url: String(row['url']),
    finalUrl: String(row['final_url']),
    sha256: String(row['sha256']),
    mime: text(row['mime']),
    sniffed: String(row['sniffed']),
    bytes: Number(row['bytes']),
    suggestedName: text(row['suggested_name']),
    downloadedAt: String(row['downloaded_at']),
    state: String(row['state']) as ResearchDownloadRow['state'],
    refusal: text(row['refusal']),
    quarantinePath: text(row['quarantine_path']),
  }
}
