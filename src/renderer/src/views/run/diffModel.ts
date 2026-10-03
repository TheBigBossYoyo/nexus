import { findChangeByNewLineNumber, getChangeKey, parseDiff, type FileData, type HunkData } from 'react-diff-view'
import type { ReviewFinding } from '@shared/domain'
import type { DiffFile } from '@shared/ipc'

export interface ParsedPatch {
  files: FileData[]
  /** Set when the patch text could not be parsed; the caller shows the raw text instead. */
  error: string | null
}

export function parsePatch(patch: string): ParsedPatch {
  if (patch.trim() === '') return { files: [], error: null }
  try {
    return { files: parseDiff(patch), error: null }
  } catch (e) {
    return { files: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/** The path a parsed file is known by (new path unless it was deleted). */
export function filePathOf(file: FileData): string {
  return file.type === 'delete' ? file.oldPath : file.newPath
}

export function normalizePath(p: string): string {
  return p.replace(/[\\]/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export function findingsForFile(findings: readonly ReviewFinding[], path: string): ReviewFinding[] {
  const target = normalizePath(path)
  return findings.filter((f) => f.file !== null && normalizePath(f.file) === target)
}

export interface FileAnnotations {
  /** Findings anchored to a change line, keyed by react-diff-view change key (widgets). */
  anchored: Record<string, ReviewFinding[]>
  /** Findings for this file that carry no line, or whose line is not part of the visible hunks. */
  unanchored: ReviewFinding[]
}

/** Place each finding next to the change at its start line (new-side numbering) when that line is in the diff. */
export function annotateFile(hunks: readonly HunkData[], fileFindings: readonly ReviewFinding[]): FileAnnotations {
  const anchored: Record<string, ReviewFinding[]> = {}
  const unanchored: ReviewFinding[] = []
  for (const f of fileFindings) {
    const change = f.lineStart === null ? undefined : findChangeByNewLineNumber([...hunks], f.lineStart)
    if (!change) {
      unanchored.push(f)
      continue
    }
    const key = getChangeKey(change)
    ;(anchored[key] ??= []).push(f)
  }
  return { anchored, unanchored }
}

export function matchesFile(file: FileData, diffFile: DiffFile): boolean {
  const p = normalizePath(diffFile.path)
  return normalizePath(file.newPath) === p || normalizePath(file.oldPath) === p
}

export interface TaskFileOwners {
  /** normalized path -> task keys that changed it */
  byPath: Map<string, string[]>
}

export function ownersByPath(perTask: readonly { taskKey: string; files: readonly DiffFile[] }[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const t of perTask) {
    for (const f of t.files) {
      const key = normalizePath(f.path)
      const list = out.get(key) ?? []
      if (!list.includes(t.taskKey)) list.push(t.taskKey)
      out.set(key, list)
    }
  }
  return out
}

const SEVERITY_ORDER: Record<ReviewFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 }

export function sortFindings<T extends { severity: ReviewFinding['severity'] }>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}
