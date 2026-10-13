import type { AutonomyCapability, CapabilityResource } from '@shared/autonomy'
import type { CommandFinding } from '@main/modules/policies/command-classifier'

/**
 * From what the command classifier found to the capability the broker is asked for. The classifier's findings
 * were written to be read by a person approving one command; here each is read once more, as a statement of
 * which boundary the command would cross.
 *
 * Two kinds of finding exist. One names a real boundary (a push, a publication, a write outside the task
 * roots, a change of the machine): it maps to a BOUNDARY capability whatever contains the process. The other
 * says only that NEXUS cannot see what will run (an encoded command, a script an agent wrote, a computed
 * command name): inside the isolated profile that is ordinary project execution, because the containment and
 * not the inspection is the boundary; outside it, it is UNCONTAINED_EXECUTION and a question for the user.
 */

export interface CapabilityNeed {
  capability: AutonomyCapability
  resource: CapabilityResource
  /** The finding that produced it, for the audit line and the request. */
  why: string
  /** Whether the resource lies inside what a profile capability covers. Always false for a boundary capability. */
  inBoundary: boolean
}

export interface NeedContext {
  /**
   * True when the command will run inside the ISOLATED execution profile: as another account, with no network
   * of its own and nothing of the user's to read. Only then is a command NEXUS could not read into a project
   * command like any other.
   */
  contained: boolean
  /**
   * True when the command will run inside any containment, RESTRICTED included: its writes are held to the
   * task's directories by Windows and its environment is the allowlist. It may still read the user's
   * unprotected files and use the network, which is why this is not `contained`.
   */
  confined?: boolean
}

const ANY: CapabilityResource = { kind: 'ANY', value: '' }
const GITHUB: CapabilityResource = { kind: 'HOST', value: 'github.com' }
const need = (capability: AutonomyCapability, why: string, resource: CapabilityResource = ANY, inBoundary = false): CapabilityNeed => ({ capability, resource, why, inBoundary })

interface Rule {
  test: RegExp
  to: (reason: string, m: RegExpExecArray, ctx: NeedContext, risk: CommandFinding['risk'] | undefined) => CapabilityNeed
}

/** Findings that name a boundary. The first rule that matches a reason decides; order matters where texts overlap. */
const BOUNDARY_RULES: Rule[] = [
  { test: /^git push --force\/--delete/, to: (r) => need('GIT_SHARED_HISTORY', r) },
  { test: /^git push publishes|^push to a local path/, to: (r) => need('GIT_PUSH', r) },
  { test: /^publishes (a package|or manages a crate|or changes registry state)/, to: (r) => need('PUBLISH_PACKAGE', r) },
  { test: /^docker (push|login)/, to: (r) => need('PUBLISH_PACKAGE', r) },
  // `gh` acts with the user's GitHub login: reading with it uses a credential, writing with it changes a third party.
  { test: /^gh .* publishes or changes GitHub|^gh api performs a write/, to: (r) => need('EXTERNAL_SIDE_EFFECT', r, GITHUB) },
  { test: /^network operation \(gh /, to: (r, _m, _ctx, risk) => (risk === 'high' ? need('EXTERNAL_SIDE_EFFECT', r, GITHUB) : need('USE_CREDENTIAL', r, { kind: 'ACCOUNT', value: 'github' })) },
  { test: /runs with elevated privileges|elevated privileges \(-Verb RunAs\)/, to: (r) => need('ELEVATE', r) },
  { test: /^registry change|^modifies the Windows registry|^changes machine\/user environment variables|^net \S+ changes accounts/, to: (r) => need('MODIFY_SYSTEM_CONFIG', r) },
  { test: /^system software change|^global package change|^global dotnet tool install|changes the global Python installation|^(go|cargo) install writes binaries outside/, to: (r) => need('INSTALL_GLOBAL_SOFTWARE', r) },
  { test: /^git config --global\/--system/, to: (r) => need('MODIFY_SYSTEM_CONFIG', r) },
  { test: /^git config .* can make git run arbitrary programs|^git config (--)?edit|writes state the user's original repository shares|^git is pointed (outside|at a location computed)/, to: (r) => need('GIT_REMOTE_CHANGE', r) },
  {
    test: /^git .* changes which branch|^git branch -(D|f)|^git tag -f|^git update-ref|^git \S+ rewrites history|^git rebase|^git reflog|^git prune|^git worktree \S+ removes/,
    to: (r) => need('GIT_SHARED_HISTORY', r),
  },
  { test: /^accessing secrets: git credential/, to: (r) => need('USE_CREDENTIAL', r) },
  // The environment of a contained process is an allowlist with no secret in it: reading it reads nothing of the user's.
  { test: /^accessing secrets: (references a key|reads environment variables|printenv reads|env prints)/, to: (r, _m, ctx) => (ctx.contained || ctx.confined === true ? need('RUN_PROJECT_COMMAND', r, ANY, true) : need('READ_PROJECT_SECRETS', r)) },
  { test: /^accessing secrets:/, to: (r) => need('READ_PROJECT_SECRETS', r) },
  { test: /^WSL is not supported/, to: (r) => need('UNCONTAINED_EXECUTION', r) },
  { test: /^requests to run outside the tool sandbox/, to: (r) => need('UNCONTAINED_EXECUTION', r) },
  // The .git entry of the worktree is NEXUS's, not the task's: a write there is a write outside the task's roots.
  { test: /Git's own (files|\.git entry)|^deleting or moving a \.git directory|an archive can carry its own \.git/, to: (r) => need('GIT_REMOTE_CHANGE', r) },
  // A write whose path NEXUS could not read (it is in a variable, or computed) is not a write outside the project:
  // it is a write NEXUS cannot place. Inside a containment Windows places it: the command can write in the task's
  // directories and nowhere else, so it is work in the worktree. A path that is written out and lies outside is
  // still the question it was. (A real session was stopped for `[IO.File]::WriteAllText($p, ...)` with `$p` the
  // README of its own worktree.)
  {
    test: /^(writes to a path that is not shown to stay inside the worktree|writes through a \.NET file API): (.*)$/,
    to: (r, m, ctx) => {
      const resource = pathResource(m[2])
      const unreadable = resource.kind === 'ANY' && /uses a variable or expansion|cannot be shown|not shown to stay/.test(r)
      return unreadable && (ctx.contained || ctx.confined === true) ? need('WRITE_WORKTREE', r, ANY, true) : need('WRITE_OUTSIDE_PROJECT', r, resource)
    },
  },
  { test: /outside the worktree/, to: (r) => need('WRITE_OUTSIDE_PROJECT', r) },
  { test: /^network operation \(git (fetch|pull|clone|submodule)|^network operation \(git /, to: (r) => need('EXTERNAL_HOST_NETWORK', r) },
  { test: /^network (operation|download)/, to: (r) => need('EXTERNAL_HOST_NETWORK', r) },
]

/** Findings that are about dependencies: inside the profile when the registries are the approved ones. */
const DEPENDENCY_RULES: RegExp[] = [/^dependency upgrade/, /^npm audit fix --force/, /installs project dependencies/]

/**
 * Findings that say "this destroys work" about the task's own disposable worktree. The worktree is the task's
 * to destroy; a path outside it is caught by its own finding.
 */
const WORKTREE_RULES: RegExp[] = [/^recursive delete/, /^forced delete/, /^find -(delete|exec)/, /^robocopy mirror/, /^git (reset --hard|clean -f|restore|checkout can discard|switch --discard-changes|stash \S+ discards)/]

function pathResource(text: string | undefined): CapabilityResource {
  const value = (text ?? '').trim()
  // The finding's text is a description, not always one path; only a plain absolute path is taken as the resource.
  return /^[a-zA-Z]:[\\/][^*?"<>|]*$/.test(value) ? { kind: 'PATH', value } : ANY
}

/**
 * The capabilities one finding calls for. A finding with no rule is one NEXUS could not read into: contained,
 * it is project execution; uncontained, it is the question "may this run outside the containment".
 */
export function needsForFinding(finding: Pick<CommandFinding, 'reason' | 'cls'> & { risk?: CommandFinding['risk'] }, ctx: NeedContext): CapabilityNeed {
  const reason = finding.reason
  for (const rule of BOUNDARY_RULES) {
    const m = rule.test.exec(reason)
    if (m !== null) return rule.to(reason, m, ctx, finding.risk)
  }
  if (DEPENDENCY_RULES.some((r) => r.test(reason))) return need('INSTALL_PROJECT_DEPENDENCIES', reason, ANY, true)
  if (WORKTREE_RULES.some((r) => r.test(reason))) {
    if (ctx.contained || ctx.confined === true) return need(/^git /.test(reason) ? 'GIT_LOCAL' : 'WRITE_WORKTREE', reason, ANY, true)
    return need('UNCONTAINED_EXECUTION', reason)
  }
  // A class the classifier gave without a text this table knows: the class decides, on the strict side.
  if (finding.cls === 'NETWORK') return need('EXTERNAL_HOST_NETWORK', reason)
  if (finding.cls === 'SYSTEM_CHANGE') return need('MODIFY_SYSTEM_CONFIG', reason)
  if (ctx.contained) return need('RUN_PROJECT_COMMAND', reason, ANY, true)
  return need('UNCONTAINED_EXECUTION', reason)
}

/** One need per capability and resource; the reasons of merged needs are joined. */
export function needsForFindings(findings: (Pick<CommandFinding, 'reason' | 'cls'> & { risk?: CommandFinding['risk'] })[], ctx: NeedContext): CapabilityNeed[] {
  const merged = new Map<string, CapabilityNeed>()
  for (const finding of findings) {
    const n = needsForFinding(finding, ctx)
    const key = `${n.capability}|${n.resource.kind}|${n.resource.value}`
    const existing = merged.get(key)
    if (existing === undefined) merged.set(key, { ...n })
    else if (!existing.why.includes(n.why)) existing.why = `${existing.why}; ${n.why}`.slice(0, 380)
  }
  return [...merged.values()]
}

/**
 * A reason from the execution policy (interpreters, scripts, package scripts) rather than the classifier. These
 * are all of the second kind, with the exceptions listed: they say what NEXUS could not vouch for.
 */
export function needForExecutionReason(reason: string, trust: string, ctx: NeedContext): CapabilityNeed {
  if (trust === 'SYSTEM_SENSITIVE') {
    if (/credential|\.ssh|\.aws|cmdkey|vaultcmd|browser profile/i.test(reason)) return need('USE_CREDENTIAL', reason)
    if (/registry|service|scheduled task|schtasks|setx|environment/i.test(reason)) return need('MODIFY_SYSTEM_CONFIG', reason)
    if (/winget|choco|msiexec|npm -g|system package|global/i.test(reason)) return need('INSTALL_GLOBAL_SOFTWARE', reason)
    return need('MODIFY_SYSTEM_CONFIG', reason)
  }
  if (/would be downloaded|not installed locally/i.test(reason)) return need('INSTALL_PROJECT_DEPENDENCIES', reason, ANY, true)
  if (/outside the worktree/i.test(reason)) return need('UNCONTAINED_EXECUTION', reason)
  if (ctx.contained) return need('RUN_PROJECT_COMMAND', reason, ANY, true)
  return need('UNCONTAINED_EXECUTION', reason)
}
