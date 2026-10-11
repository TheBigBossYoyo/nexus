import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProcessResult, RunProcessOptions } from '@main/modules/process/run-process'
import type { ExecutionBroker, ExecutionProfileName } from './execution-broker'
import type { ContainmentCheck, Launcher } from './launcher'
import { createShellContainment, effectiveProfile, type ContainmentSetting, type ShellContainment } from './session-containment'

/**
 * 0.8: the containment of project code as the runtime holds it: which profile an enrolled project's code runs
 * under, the shell containment of a session, NEXUS's own project commands, and the labels that keep contained
 * code from reading what the user protected. A project that is not enrolled is not contained here: it keeps
 * the behaviour of 0.7, approvals included.
 */

export interface IsolationStatus {
  /** What Settings asks for. */
  requested: ContainmentSetting
  /** What that means on this machine now. */
  effective: ExecutionProfileName
  /** Whether the effective profile was verified at this start and holds. */
  usable: boolean
  detail: string
  isolated: ContainmentCheck | null
  restricted: ContainmentCheck | null
  /** Whether the machine's sandbox account is set up. */
  sandboxAccount: boolean
  /** The directories and files marked unreadable for contained code. */
  protectedPaths: string[]
  /** Launches prepared inside a containment since this start, and launches refused because none could be made. */
  launches: { shell: number; commands: number; programs: number; refused: number }
}

export interface IsolationServiceDeps {
  broker: ExecutionBroker
  launcher: Launcher
  containment: () => ContainmentSetting
  enrolled: (projectId: string) => boolean
  /** The directories of the repository a contained git may write for a worktree, from NEXUS's own record. */
  gitWritable?: (worktree: string) => Promise<string[]>
  /** NEXUS's data directory: protected as a whole, except the worktrees and the sandbox state inside it. */
  dataDir: string
  logger?: (line: string) => void
}

/** Credential stores in the user's home that contained code has no business reading. Only what exists is labeled. */
export function credentialPaths(home: string = homedir()): string[] {
  return ['.claude', '.codex', '.ssh', '.aws', '.azure', '.gnupg', '.docker', join('.config', 'gh'), '.npmrc', '.netrc', '.git-credentials'].map((p) => join(home, p))
}

export class IsolationService {
  private protectedPaths: string[] = []

  constructor(private readonly deps: IsolationServiceDeps) {}

  /** Verifies both profiles by running them. Called once at start, before any session is dispatched. */
  async start(): Promise<IsolationStatus> {
    await this.deps.broker.verify('RESTRICTED').catch(() => undefined)
    await this.deps.broker.verify('ISOLATED').catch(() => undefined)
    return this.status()
  }

  profileFor(projectId: string): ExecutionProfileName {
    if (!this.deps.enrolled(projectId)) return 'STANDARD'
    return effectiveProfile(this.deps.containment(), this.deps.broker)
  }

  /** Whether a session of this project runs its commands inside a containment that was verified. */
  contained(projectId: string): boolean {
    const profile = this.profileFor(projectId)
    return profile !== 'STANDARD' && this.deps.broker.usable(profile).usable
  }

  /** The shell containment of a session; undefined for a project that is not enrolled. */
  shellFor(session: { projectId: string; sessionKey: string; worktree: string; cwd: string }): ShellContainment | undefined {
    if (!this.deps.enrolled(session.projectId)) return undefined
    const gitWritable = this.deps.gitWritable
    return createShellContainment({ broker: this.deps.broker, profile: this.profileFor(session.projectId), ...session, ...(gitWritable ? { gitWritable: () => gitWritable(session.worktree) } : {}) })
  }

  /**
   * Runs a command NEXUS itself runs in a project inside the project's containment. Null when the project is
   * not contained (not enrolled, or STANDARD): the caller then runs it as before. Throws when a containment
   * was asked for and cannot be made.
   */
  async runProjectCommand(input: { projectId: string; sessionKey: string; worktree: string; commandLine: string }, options: Omit<RunProcessOptions, 'cwd' | 'env'>): Promise<ProcessResult | null> {
    const profile = this.profileFor(input.projectId)
    if (profile === 'STANDARD') return null
    return this.deps.broker.runProjectCommand({ ...input, profile }, options)
  }

  /**
   * Marks NEXUS's own data and the user's credential stores unreadable for contained code, once. A record of
   * what was marked is kept so that it is not done again at every start and can be undone. Only the integrity
   * label of each path changes. Paths that do not exist are skipped.
   */
  async protect(options: { userStores: boolean } = { userStores: true }): Promise<string[]> {
    const record = join(this.deps.dataDir, 'sandbox', 'protected.json')
    let known: string[]
    try {
      known = (JSON.parse(readFileSync(record, 'utf8')) as { paths?: string[] }).paths ?? []
    } catch {
      known = []
    }
    // One enrolled repository cannot be protected from the code of another with a label: a label says who may
    // read by integrity, not by project. Only the sandbox account keeps projects apart.
    const wanted = [this.deps.dataDir, ...(options.userStores ? credentialPaths() : [])].filter((p) => existsSync(p))
    const done = new Set(known.map((p) => p.toLowerCase()))
    let changed = false
    for (const path of wanted) {
      if (done.has(path.toLowerCase())) continue
      try {
        await this.deps.launcher.label('protect', path)
        known.push(path)
        done.add(path.toLowerCase())
        changed = true
      } catch (e) {
        this.deps.logger?.(`isolation: ${path} could not be protected: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (changed) {
      mkdirSync(join(this.deps.dataDir, 'sandbox'), { recursive: true })
      writeFileSync(record, JSON.stringify({ paths: known, at: new Date().toISOString() }, null, 2))
    }
    this.protectedPaths = known
    return known
  }

  /**
   * Takes the marks off again: every path the record names goes back to having no label of its own. Called
   * when no project is enrolled any more, so that NEXUS leaves nothing changed that serves nobody. A path that
   * cannot be cleared stays on the record and is tried again the next time.
   */
  async unprotect(): Promise<string[]> {
    const record = join(this.deps.dataDir, 'sandbox', 'protected.json')
    let known: string[]
    try {
      known = (JSON.parse(readFileSync(record, 'utf8')) as { paths?: string[] }).paths ?? []
    } catch {
      return []
    }
    const left: string[] = []
    for (const path of known) {
      if (!existsSync(path)) continue
      try {
        await this.deps.launcher.label('clear', path)
      } catch (e) {
        left.push(path)
        this.deps.logger?.(`isolation: the protection of ${path} could not be removed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    writeFileSync(record, JSON.stringify({ paths: left, at: new Date().toISOString() }, null, 2))
    this.protectedPaths = left
    return left
  }

  status(): IsolationStatus {
    const requested = this.deps.containment()
    const effective = effectiveProfile(requested, this.deps.broker)
    const state = this.deps.broker.usable(effective)
    return {
      requested,
      effective,
      usable: state.usable,
      detail: state.detail,
      isolated: this.deps.broker.status('ISOLATED'),
      restricted: this.deps.broker.status('RESTRICTED'),
      sandboxAccount: this.deps.broker.isolatedWorktreesRoot() !== null,
      launches: this.deps.broker.counters(),
      protectedPaths: this.protectedPaths,
    }
  }
}
