import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { NexusError } from '@shared/result'
import { newId, nowIso } from '@shared/ids'
import { ArenaCaseDefinitionSchema } from '@shared/v3'
import type { ArenaCase, ArenaCaseDefinition, ArenaCaseVersion } from '@shared/v3'
import type { ArenaCaseSummary } from '@shared/v3-read'
import { tokenizeCommandLine } from '../process'
import type { Repositories } from '../persistence'

export type CaseOrigin = ArenaCase['origin']

/** A case directory read from disk: validated definition, hashes, and the three directories. */
export interface LoadedCase {
  definition: ArenaCaseDefinition
  dir: string
  fixtureDir: string
  evaluatorDir: string
  fixtureHash: string
  evaluatorHash: string
  readme: string | null
}

/** Every command a case runs, in the order NEXUS runs them. Shown to the user before an imported case is trusted. */
export interface CaseCommands {
  setup: string[]
  checks: string[]
  hiddenEvaluation: string
}

const toPosix = (p: string): string => p.split(sep).join('/')

/** Relative posix paths of every file under `dir`, sorted. Symlinks are refused: a case must be plain files. */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        throw new NexusError('invalid_input', `Case directories may not contain symbolic links: ${full}`)
      }
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) out.push(toPosix(relative(dir, full)))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

/** Text files are hashed with LF endings so a checkout with autocrlf does not change a case's identity. */
export function normalizedBytes(content: Buffer): Buffer {
  if (content.includes(0)) return content
  return Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

/** SHA-256 over sorted relative paths and (line-ending normalized) contents. */
export function hashDirectory(dir: string): string {
  const hash = createHash('sha256')
  for (const rel of listFilesRecursive(dir)) {
    hash.update(rel, 'utf8')
    hash.update('\0')
    hash.update(normalizedBytes(readFileSync(join(dir, rel))))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** The evaluator hash covers the files AND the command that runs them: changing either is a different evaluator. */
export function hashEvaluator(evaluatorDir: string, evaluation: ArenaCaseDefinition['hiddenEvaluation']): string {
  const hash = createHash('sha256')
  hash.update(hashDirectory(evaluatorDir))
  hash.update('\0command\0')
  hash.update(evaluation.command)
  hash.update('\0timeout\0')
  hash.update(String(evaluation.timeoutSeconds))
  return hash.digest('hex')
}

export function caseCommands(definition: ArenaCaseDefinition): CaseCommands {
  const checks = (['build', 'test', 'lint', 'typecheck'] as const).flatMap((k) => {
    const command = definition.checks[k]
    return command ? [command] : []
  })
  return { setup: [...definition.setup], checks, hiddenEvaluation: definition.hiddenEvaluation.command }
}

/** Human-readable command list for the trust prompt. */
export function describeCommands(definition: ArenaCaseDefinition): string[] {
  const c = caseCommands(definition)
  return [
    ...c.setup.map((cmd) => `setup: ${cmd}`),
    ...c.checks.map((cmd) => `check: ${cmd}`),
    `hidden evaluation: ${c.hiddenEvaluation}`,
  ]
}

function assertCommandsParse(definition: ArenaCaseDefinition): void {
  const c = caseCommands(definition)
  for (const command of [...c.setup, ...c.checks, c.hiddenEvaluation]) {
    // Throws NexusError('invalid_input') for shell operators: cases never rely on a shell.
    tokenizeCommandLine(command)
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Reads and validates one case directory. Throws NexusError('invalid_input') with the reason. */
export function loadCaseDirectory(dir: string): LoadedCase {
  const root = resolve(dir)
  const caseFile = join(root, 'case.json')
  if (!existsSync(caseFile)) throw new NexusError('invalid_input', `Not an Arena case (no case.json): ${root}`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(caseFile, 'utf8'))
  } catch (e) {
    throw new NexusError('invalid_input', `case.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const parsed = ArenaCaseDefinitionSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new NexusError('invalid_input', `Invalid case definition in ${caseFile}: ${issues}`)
  }
  const definition = parsed.data
  const fixtureDir = join(root, 'fixture')
  const evaluatorDir = join(root, 'evaluator')
  if (!isDirectory(fixtureDir) || listFilesRecursive(fixtureDir).length === 0) {
    throw new NexusError('invalid_input', `Case ${definition.id} has no fixture/ files`)
  }
  if (!isDirectory(evaluatorDir) || listFilesRecursive(evaluatorDir).length === 0) {
    throw new NexusError('invalid_input', `Case ${definition.id} has no evaluator/ files`)
  }
  assertCommandsParse(definition)
  const readmePath = join(root, 'README.md')
  return {
    definition,
    dir: root,
    fixtureDir,
    evaluatorDir,
    fixtureHash: hashDirectory(fixtureDir),
    evaluatorHash: hashEvaluator(evaluatorDir, definition.hiddenEvaluation),
    readme: existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : null,
  }
}

export interface RegisteredCase extends ArenaCaseSummary {
  /** True when this call created the version row. */
  created: boolean
}

/**
 * Registers one loaded case. A new `version` creates a new version row. The same version with a different
 * evaluator or fixture is refused: a result must always name the exact evaluator that produced it.
 */
export function registerLoadedCase(repos: Repositories, loaded: LoadedCase, origin: CaseOrigin): RegisteredCase {
  const def = loaded.definition
  const existingCase = repos.arenaCases.get(def.id)
  if (existingCase && existingCase.origin !== origin) {
    throw new NexusError('invalid_state', `Case id "${def.id}" is already registered as ${existingCase.origin}; refusing to replace it`)
  }
  const sameVersion = repos.arenaCaseVersions.getVersion(def.id, def.version)
  const now = nowIso()
  if (sameVersion) {
    if (sameVersion.evaluatorHash !== loaded.evaluatorHash) {
      throw new NexusError(
        'invalid_state',
        `The evaluator of case ${def.id} v${def.version} changed without a version bump; bump "version" to register it`,
        { caseId: def.id, version: def.version },
      )
    }
    if (sameVersion.fixtureHash !== loaded.fixtureHash) {
      throw new NexusError(
        'invalid_state',
        `The fixture of case ${def.id} v${def.version} changed without a version bump; bump "version" to register it`,
        { caseId: def.id, version: def.version },
      )
    }
    // Same content: the directory may have moved (dev vs packaged build); the row follows it.
    const caseRow = repos.arenaCases.update(def.id, { sourcePath: loaded.dir, updatedAt: now, name: def.name })
    return { case: caseRow, version: sameVersion, created: false }
  }
  if (existingCase && existingCase.latestVersion > def.version) {
    throw new NexusError(
      'invalid_state',
      `Case ${def.id} is already registered at version ${existingCase.latestVersion}; versions only increase`,
    )
  }
  const version: ArenaCaseVersion = {
    id: newId(),
    caseId: def.id,
    version: def.version,
    definition: def,
    evaluatorHash: loaded.evaluatorHash,
    fixtureHash: loaded.fixtureHash,
    // Shipped cases are trusted; everything else needs an explicit confirmation of its commands.
    trusted: origin === 'builtin',
    createdAt: now,
  }
  return repos.transaction(() => {
    const caseRow: ArenaCase = existingCase
      ? repos.arenaCases.update(def.id, {
          name: def.name,
          category: def.category,
          complexity: def.complexity,
          risk: def.risk,
          latestVersion: def.version,
          sourcePath: loaded.dir,
          updatedAt: now,
        })
      : repos.arenaCases.insert({
          id: def.id,
          name: def.name,
          origin,
          category: def.category,
          complexity: def.complexity,
          risk: def.risk,
          latestVersion: def.version,
          sourcePath: loaded.dir,
          createdAt: now,
          updatedAt: now,
        })
    repos.arenaCaseVersions.insert(version)
    return { case: caseRow, version, created: true }
  })
}

/** Case directories directly under `casesDir` (those containing a case.json), sorted by name. */
export function listCaseDirectories(casesDir: string): string[] {
  if (!isDirectory(casesDir)) return []
  return readdirSync(casesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(casesDir, e.name, 'case.json')))
    .map((e) => join(casesDir, e.name))
    .sort((a, b) => basename(a).localeCompare(basename(b)))
}

/** Upserts every case under `casesDir`. Throws on the first invalid case or changed evaluator. */
export function registerCases(repos: Repositories, casesDir: string, origin: CaseOrigin): RegisteredCase[] {
  return listCaseDirectories(casesDir).map((dir) => registerLoadedCase(repos, loadCaseDirectory(dir), origin))
}

export interface ImportedCase {
  summary: ArenaCaseSummary
  /** Everything NEXUS would execute for this case, to show before it is trusted. */
  commands: string[]
}

/** Registers a user-supplied case directory as `imported` and untrusted. Nothing from it is executed here. */
export function importCase(repos: Repositories, dir: string): ImportedCase {
  const loaded = loadCaseDirectory(dir)
  const registered = registerLoadedCase(repos, loaded, 'imported')
  return {
    summary: { case: registered.case, version: registered.version },
    commands: describeCommands(registered.version.definition),
  }
}

/**
 * Confirms the commands of one imported case version. The directory is re-hashed first: what the user saw
 * and confirmed is exactly what is stored, so a case edited after the import cannot be trusted by accident.
 */
export function trustCaseVersion(repos: Repositories, caseVersionId: string): ArenaCaseVersion {
  const version = repos.arenaCaseVersions.require(caseVersionId)
  if (version.trusted) return version
  const caseRow = repos.arenaCases.require(version.caseId)
  const loaded = loadCaseDirectory(caseRow.sourcePath)
  if (
    loaded.definition.version !== version.version ||
    loaded.evaluatorHash !== version.evaluatorHash ||
    loaded.fixtureHash !== version.fixtureHash
  ) {
    throw new NexusError(
      'invalid_state',
      `Case ${version.caseId} changed on disk since it was imported; import it again to review its commands`,
    )
  }
  return repos.arenaCaseVersions.update(version.id, { trusted: true })
}

/** Re-reads a registered case from its source directory and refuses it when it no longer matches the stored hashes. */
export function loadVerifiedCase(sourcePath: string, version: ArenaCaseVersion): LoadedCase {
  const loaded = loadCaseDirectory(sourcePath)
  if (loaded.definition.version !== version.version || loaded.definition.id !== version.caseId) {
    throw new NexusError('invalid_state', `Case ${version.caseId} on disk is not version ${version.version}`)
  }
  if (loaded.evaluatorHash !== version.evaluatorHash) {
    throw new NexusError('invalid_state', `The evaluator of case ${version.caseId} v${version.version} changed since it was registered`)
  }
  if (loaded.fixtureHash !== version.fixtureHash) {
    throw new NexusError('invalid_state', `The fixture of case ${version.caseId} v${version.version} changed since it was registered`)
  }
  return loaded
}
