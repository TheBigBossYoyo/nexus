import { basename, dirname, join } from 'node:path'
import type { ExecutionBroker, ExecutionProfileName, ShellKind } from './execution-broker'
import type { ContainmentProfile } from './launcher'
import { renderGrantedPush, renderUserGitScript, type UserGitInvocation } from '@main/modules/policies/git-pipeline'

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
  /**
   * 0.9.1, STANDARD only: the commands still run as written and as the user, but on a desktop of their own, so
   * that what they open is on no screen and takes no focus (presentation, not containment).
   */
  readonly quiet?: boolean
  /** `gitScript`: for a command that is git and nothing else, the script NEXUS wrote from its parsed invocations. It is what runs; the command's text is not. */
  /**
   * `grantedPush`: the command is git invocations with a push among them, and the user allowed the push (the
   * capability broker authorized it by a grant). Each push runs as the user, outside the containment, as the
   * script NEXUS writes from it; the git around it runs as git as the user does, inside the containment.
   */
  wrap(shell: ShellKind, command: string, options: { gitOnly: boolean; gitScript?: string; grantedPush?: UserGitInvocation[] }): Promise<{ ok: true; command: string } | { ok: false; reason: string }>
}

/** What the user asked for in Settings. STRONGEST: the sandbox account when it is set up and holds, else the low-integrity profile. */
export type ContainmentSetting = 'STRONGEST' | 'ISOLATED' | 'RESTRICTED' | 'STANDARD'

/**
 * The profile a setting means on this machine now. STRONGEST never means STANDARD: when neither containment
 * holds it stays RESTRICTED, which then refuses to run anything, and says why.
 */
export function effectiveProfile(setting: ContainmentSetting, broker: Pick<ExecutionBroker, 'usable'>, isolatedSetUp = false): ExecutionProfileName {
  if (setting !== 'STRONGEST') return setting
  if (broker.usable('ISOLATED').usable) return 'ISOLATED'
  // A machine where the isolated profile was set up and does not hold at this start does not quietly run
  // project code as the user instead: the profile stays the isolated one, which is then not usable, and says
  // why. RESTRICTED is the strongest only where the isolated profile was never set up.
  return isolatedSetUp ? 'ISOLATED' : 'RESTRICTED'
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
  /** 0.9.1, STANDARD: start the commands quietly (a desktop of their own). */
  quiet?: boolean
  /** A quiet start that could not be prepared: the command then runs as written, visibly, and this is told why. */
  onVisible?: (reason: string) => void
}): ShellContainment {
  const { broker, profile } = input
  const state = broker.usable(profile)
  const quiet = profile === 'STANDARD' && input.quiet === true
  return {
    profile,
    unavailable: state.usable ? null : state.detail,
    quiet,
    async wrap(shell, command, options) {
      if (profile === 'STANDARD') {
        if (!quiet) return { ok: true, command }
        const present = await broker.presentShell({ sessionKey: input.sessionKey, worktree: input.worktree, cwd: input.cwd, shell, command })
        if (!present.ok) {
          // Presentation is not a boundary: a command that cannot be started quietly still runs, as it always did.
          input.onVisible?.(present.reason)
          return { ok: true, command }
        }
        const [spec] = present.args.slice(-1)
        return { ok: true, command: shell === 'bash' ? `${singleQuoted(present.file)} --spec ${singleQuoted(spec as string)}` : `& ${psQuoted(present.file)} --spec ${psQuoted(spec as string)}; exit $LASTEXITCODE` }
      }
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
      if (options.grantedPush !== undefined) {
        // Without NEXUS's record of the worktree the push is not made at all: nothing of it is taken from the worktree.
        if (gitDir === undefined || gitBranch === undefined) return { ok: false, reason: 'NEXUS has no record of the Git directory and branch of this worktree, so the push that was allowed was not made.' }
        if (!(await broker.hasBash(asUser))) return { ok: false, reason: 'Git Bash was not found, so the push that was allowed cannot be run by NEXUS.' }
        // The line is cut where a push stands: each push is a script of its own, run as the user; each stretch of
        // other git between pushes is one script of git as the user, run inside the containment as always.
        const parts: { text: string; then: UserGitInvocation['then'] }[] = []
        let stretch: UserGitInvocation[] = []
        const closeStretch = async (): Promise<string | null> => {
          if (stretch.length === 0) return null
          const then = (stretch[stretch.length - 1] as UserGitInvocation).then
          const script = renderUserGitScript(stretch.map((invocation, i) => (i === stretch.length - 1 ? { ...invocation, then: null } : invocation)))
          stretch = []
          const contained = await broker.containShell({ profile: asUser, sessionProfile: profile, projectId: input.projectId, sessionKey: input.sessionKey, worktree: input.worktree, cwd: input.cwd, shell: 'bash', command: script, gitOnly: true, gitWritable, gitDir, gitBranch })
          if (!contained.ok) return contained.reason
          const [spec] = contained.args.slice(-1)
          parts.push({ text: shell === 'bash' ? `${singleQuoted(contained.file)} --spec ${singleQuoted(spec as string)}` : `& ${psQuoted(contained.file)} --spec ${psQuoted(spec as string)}`, then })
          return null
        }
        for (const invocation of options.grantedPush) {
          if (invocation.args[0] !== 'push') {
            stretch.push(invocation)
            continue
          }
          const failed = await closeStretch()
          if (failed !== null) return { ok: false, reason: failed }
          const granted = await broker.grantedPush({ projectId: input.projectId, worktree: input.worktree, gitDir, pushLine: renderGrantedPush(invocation, gitBranch) })
          if (!granted.ok) return { ok: false, reason: granted.reason }
          parts.push({ text: shell === 'bash' ? `${singleQuoted(granted.bash)} --noprofile --norc ${singleQuoted(granted.script)}` : `& ${psQuoted(granted.bash)} --noprofile --norc ${psQuoted(granted.script)}`, then: invocation.then })
        }
        const failed = await closeStretch()
        if (failed !== null) return { ok: false, reason: failed }
        // Joined as the command joined them. A command written for PowerShell has `;` only (its reading allows no other).
        const text = parts.map((part, i) => (i === parts.length - 1 ? part.text : `${part.text} ${part.then === '&&' || part.then === '||' ? part.then : ';'}`)).join(' ')
        return { ok: true, command: shell === 'bash' ? text : `${text}; exit $LASTEXITCODE` }
      }
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
