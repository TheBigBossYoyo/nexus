import { basename, dirname, join } from 'node:path'
import type { ExecutionBroker, ExecutionProfileName, ShellKind } from './execution-broker'
import type { ContainmentProfile } from './launcher'

/**
 * 0.8: how the shell commands of one agent session run. The tool authorizer of an enrolled project holds one
 * of these; after it has decided that a command may run, it asks here for the command that runs it inside the
 * containment, and gives that to the provider's shell tool in place of the agent's text.
 */
export interface ShellContainment {
  /** The profile this session's commands run under. STANDARD: no containment, the command runs as written. */
  readonly profile: ExecutionProfileName
  /** Why the profile cannot be used now, or null. A session whose profile is unusable runs no command. */
  readonly unavailable: string | null
  /** `gitScript`: for a command that is git and nothing else, the script NEXUS wrote from its parsed invocations. It is what runs; the command's text is not. */
  wrap(shell: ShellKind, command: string, options: { gitOnly: boolean; gitScript?: string }): Promise<{ ok: true; command: string } | { ok: false; reason: string }>
}

/** What the user asked for in Settings. STRONGEST: the sandbox account when it is set up and holds, else the low-integrity profile. */
export type ContainmentSetting = 'STRONGEST' | 'ISOLATED' | 'RESTRICTED' | 'STANDARD'

/**
 * The profile a setting means on this machine now. STRONGEST never means STANDARD: when neither containment
 * holds it stays RESTRICTED, which then refuses to run anything, and says why.
 */
export function effectiveProfile(setting: ContainmentSetting, broker: Pick<ExecutionBroker, 'usable'>): ExecutionProfileName {
  if (setting !== 'STRONGEST') return setting
  return broker.usable('ISOLATED').usable ? 'ISOLATED' : 'RESTRICTED'
}

const singleQuoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
const psQuoted = (text: string): string => `'${text.replace(/'/g, "''")}'`

export function createShellContainment(input: {
  broker: ExecutionBroker
  profile: ExecutionProfileName
  projectId: string
  sessionKey: string
  worktree: string
  cwd: string
  /** The directories of the repository a contained git of this session may write, from NEXUS's record of the worktree. */
  gitWritable?: () => Promise<string[]>
}): ShellContainment {
  const { broker, profile } = input
  const state = broker.usable(profile)
  return {
    profile,
    unavailable: state.usable ? null : state.detail,
    async wrap(shell, command, options) {
      if (profile === 'STANDARD') return { ok: true, command }
      const gitWritable = input.gitWritable ? await input.gitWritable().catch(() => []) : []
      const objects = gitWritable.find((dir) => basename(dir).toLowerCase() === 'objects')
      const gitDir = objects !== undefined ? gitWritable.find((dir) => basename(dirname(dir)).toLowerCase() === 'worktrees' && dirname(dirname(dir)).toLowerCase() === dirname(objects).toLowerCase()) : undefined
      // Treated as git alone only with all four (the fourth is the worktree's own branch, below): NEXUS's own script (what runs is never the command's text), the
      // Git directory NEXUS recorded for the worktree (without it git would take the repository from the `.git`
      // file in the worktree, which the task writes), and a bash to run the script (it is a bash script whichever
      // shell the command was written for). Otherwise the command runs under the session's own profile, as any other.
      const asUser: ContainmentProfile = profile === 'ISOLATED' && broker.usable('RESTRICTED').usable ? 'RESTRICTED' : profile
      // The worktree's own branch: the file among the refs that NEXUS's record names (the longest path it lists there).
      const heads = objects !== undefined ? join(dirname(objects), 'refs', 'heads').toLowerCase() : null
      const branchFile = heads === null ? undefined : gitWritable.filter((path) => path.toLowerCase().startsWith(`${heads}\\`)).sort((a, b) => b.length - a.length)[0]
      const branchParts = branchFile !== undefined && heads !== null ? branchFile.slice(heads.length + 1).split(/[\\/]/) : []
      // A branch NEXUS made is `nexus/<run>/<task>`: three parts at least. Anything shorter is a directory of refs, not a branch.
      const gitBranch = branchParts.length >= 3 ? branchParts.join('/') : undefined
      const gitOnly = options.gitOnly && options.gitScript !== undefined && gitDir !== undefined && gitBranch !== undefined && (await broker.hasBash(asUser))
      // A command that is git and nothing else (or git and text filters) runs as the user at low integrity even
      // in an ISOLATED session: only there can git change a ref of a repository that is in the user's profile.
      // Every other command runs as the sandbox account, which is given what git needs to read the repository
      // and to stage. The repository's Git directory is the one above the `objects` directory NEXUS recorded.
      const use: ContainmentProfile = gitOnly ? asUser : profile
      const gitCommonDir = use === 'ISOLATED' && objects !== undefined ? dirname(objects) : undefined
      const contained = await broker.containShell({ profile: use, sessionProfile: profile, projectId: input.projectId, sessionKey: input.sessionKey, worktree: input.worktree, cwd: input.cwd, shell: gitOnly ? 'bash' : shell, command: gitOnly ? (options.gitScript as string) : command, gitOnly, gitWritable, ...(gitCommonDir !== undefined ? { gitCommonDir } : {}), ...(gitDir !== undefined ? { gitDir } : {}), ...(gitBranch !== undefined ? { gitBranch } : {}) })
      if (!contained.ok) return { ok: false, reason: contained.reason }
      const [spec] = contained.args.slice(-1)
      const text = shell === 'bash' ? `${singleQuoted(contained.file)} --spec ${singleQuoted(spec as string)}` : `& ${psQuoted(contained.file)} --spec ${psQuoted(spec as string)}; exit $LASTEXITCODE`
      return { ok: true, command: text }
    },
  }
}
