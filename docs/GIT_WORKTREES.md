# Git and worktrees

Code: `src/main/modules/git/` (`GitService`, `WorktreeManager`, `paths.ts`) and
`src/main/modules/process/` (`runProcess`, `killProcessTree`). `GitService` runs `git` with
`spawn` and an argument array (no shell, `windowsHide`), so branch names, paths and messages are never
interpolated into a command line. Revisions that start with `-` are rejected.

## Naming

`<run>` is `shortId(runId)`: the first 8 hex characters of the run id.

| Thing | Name |
|---|---|
| Integration branch | `nexus/<run>/integration` |
| Integration worktree | `<data dir>\worktrees\<run>\integration` |
| Task branch | `nexus/<run>/<key>` |
| Task worktree | `<data dir>\worktrees\<run>\<key>` |

`<key>` is the planner's task id, sanitized by `WorktreeManager.planPaths`: lowercased, runs of
characters outside `a-z0-9` become `-`, trimmed, cut to 24 characters. If sanitizing changed the key (or the key is a Windows reserved device name such as `con`, `aux`, `nul`,
`com1` or `lpt1`, which cannot be a directory name), a
4 hex digit SHA-1 suffix is appended so two different keys cannot collide (an empty result becomes
`task-<hash>`). If the branch name already exists (a leftover from a lost worktree, or a task literally
called `integration`), the pipeline appends a short random id instead of failing on the clash.
Repair tasks (`<key>-fix<n>`) do not get their own worktree: they run in their parent's.

## Lifecycle of a run's Git objects

1. **Run start.** `createRun` records `baseBranch` (current branch, null if detached) and `baseCommit`
   (`HEAD`). Nothing is created yet.
2. **Integration branch.** Created lazily by `ensureIntegration` the first time a writing task needs a
   worktree: `git worktree add --no-track -b nexus/<run>/integration <path>
   <baseCommit>`. It is recorded in `worktrees` (with `taskId` null) and `runs.integrationBranch`.
3. **Task worktree.** When a writing task starts, `git worktree add --no-track -b nexus/<run>/<key>
   <path> <integration branch>`. Because a task only starts after its dependencies are completed, it
   begins from an integration tip that already contains their merged work.
4. **Install.** `Core.setupWorktree` runs the lockfile's package manager install in the new worktree
   (`pnpm install --frozen-lockfile --prefer-offline`, `yarn install --frozen-lockfile`,
   `bun install --frozen-lockfile` or `npm ci`) and stores the output as a `setup-log` artifact. A project with no
   detected package manager gets no install step.
5. **Work.** The agent edits and commits inside its worktree. Before checks, `commitLeftovers` runs
   `git add -A` and commits anything uncommitted, so the diff that is reviewed is the diff that is merged.
   Commits use the author from Settings, Git (default `NEXUS Agent <nexus-agent@localhost>`), passed per
   invocation with `-c user.name/user.email`, with `commit.gpgsign=false` and `--no-verify` (hooks are
   skipped; NEXUS runs its own checks).
6. **Merge.** After verification (below).
7. **Cleanup.** Worktrees are removed only by `runs.cleanup` (finished runs) or, if
   `git.removeWorktreesOnSuccess` is enabled, right after a task's merge. Branches are never deleted.

Diffs shown in the UI: a task's diff is its worktree against the merge base with the integration branch
(`diffWorkingTree`, which snapshots into a throwaway index so the real index is untouched); the run diff is
`baseCommit..integration branch`.

## Merge protocol and conflict handling

`TaskPipeline.execute`, after a task's verification passes:

1. `withMergeLock(runId, ...)` serializes merges for the run (a promise chain), so only one task merges
   into the integration branch at a time.
2. `GitService.merge(integration.path, task.branch, ...)` runs, in the integration worktree,
   `git merge --no-ff --no-edit --no-verify -m "Merge <key>: <title>" <sha>`. It first requires that no
   merge is in progress and that the integration worktree is clean (staged, unstaged and untracked files
   all count, ignored files do not), otherwise it throws `dirty_repository`. Check and setup commands run in
   the integration worktree can leave files behind, so the pipeline first restores the (NEXUS-owned)
   integration worktree with `WorktreeManager.resetClean`: `git reset --hard HEAD` (which also clears an
   interrupted merge) and `git clean -fd`, never `-x`, so ignored dependencies survive. It refuses paths
   outside the worktrees root. A repository that does not ignore its install output (for example
   `node_modules`) loses it in this step.
3. Success: the worktree row becomes `merged`, `git.merged` is emitted with the merge commit, the task
   completes.
4. Conflict: the conflicting paths are collected (`git diff --name-only --diff-filter=U`), the merge is
   aborted (`git merge --abort`) so the integration worktree is left clean, and `{ ok: false, conflicts }` is
   returned. `git.conflict` is emitted and the task enters the repair loop. The debugger works in the task
   worktree and is told to run `git merge <integration branch>` there, resolve the conflicts, run the
   tests and commit. The pipeline then restarts at checks, so the merged result is re-checked, re-reviewed
   and re-verified before the next merge attempt. Repair attempts share the task's `repairCycles` budget
   (`maxIterations`).

The integration branch therefore contains only verified work, merged with `--no-ff`, one merge commit per
task. Mission-level checks and verification run on it before the run completes (ORCHESTRATION.md).

## What NEXUS never does

In NEXUS's own Git calls (everything in `GitService`, as used by the orchestrator):

- No `push`, and no remote operation of any kind.
- No `checkout`, `stash`, `rebase` or `gc`. `reset --hard` and `clean -fd` exist only as `GitService.resetClean`,
  reachable through `WorktreeManager.resetClean`, which refuses any path outside the NEXUS worktrees root; they
  are applied to the integration worktree before merges and after mission checks, and to a task worktree after
  its checks (to discard check side effects). Never to your checkout.
- No force option on removal in practice: `removeWorktree(..., { force: true })` exists in the API, but the
  application never passes it. `worktree remove` is refused when the worktree has uncommitted or untracked
  changes.
- No `branch -D`. `GitService.deleteBranch` exists (`git branch -d`, which refuses unmerged branches) but
  is not called by the application.
- No write to your working tree, index or checked-out branch. In your repository NEXUS runs read commands
  (status, rev-parse, branch lookup, log, diff, merge-base) and the worktree commands below. Those do change
  repository metadata under `.git`: new branches `nexus/*` and worktree registrations.
- `WorktreeManager.remove` refuses any path outside the NEXUS worktrees root (`path_violation`).

Agents are a separate matter. Their tool calls pass through the policy engine (SECURITY.md): in their
worktree they may run ordinary Git commands, the classifier requires approval for pushes, `reset --hard`,
`clean -f`, `branch -D`, history rewriting, `git worktree remove` and a few more, and the role prompts tell
them never to push, switch or create branches, touch other worktrees, or rewrite history. Those prompts
are instructions, not enforcement.

Read-only agents (the planner, ASK and AUDIT tasks, and read-only tasks that run before an integration
worktree exists) run with your project directory as their working directory. The write tools are not
available to their roles and their shell access is limited by the role's command policy (SECURITY.md),
but they see the directory's current, possibly uncommitted, contents. Reviewer roles may also run
test, build and lint commands there.

## Cleanup and orphan handling

| Situation | What happens |
|---|---|
| `runs.cleanup` on a finished run | For each worktree not already `removed`: `worktree remove` (clean only), mark `removed`, emit `git.worktree.removed`. A worktree that cannot be removed (for example it has changes) is skipped and logged. Branches stay. |
| `git.removeWorktreesOnSuccess` | The merged task's worktree is removed immediately after the merge, if clean. |
| Worktree directory vanished (found on recovery) | On every resume (`runs.resume`, or `runs.recover` with `resume`), `reconcileWorktrees` marks that worktree `orphaned` and runs `git worktree prune`. A task whose worktree is gone gets a fresh worktree on its next start (with a new branch name, since the old branch still exists). |
| Merge left in progress by a crash | On resume, `git merge --abort` is run in any existing worktree that has `MERGE_HEAD`. |
| Worktrees unknown to NEXUS | `WorktreeManager.findOrphans` and `cleanupOrphans` implement detection and safe removal (clean ones removed, dirty ones reported, never deleted) but the application does not call them. Such worktrees stay until you remove them with Git. |

Run directories under `worktrees\<run>\` are removed when empty.

## How to merge results

When a run is `completed` (or even earlier, for partial results), from your repository:

```powershell
git log --oneline <your branch>..nexus/<run>/integration
git diff <your branch>...nexus/<run>/integration
git merge nexus/<run>/integration
```

Merge into a branch you have checked out, ideally the `baseBranch` shown for the run. The integration
branch started from `baseCommit`, so if your branch moved since then, Git handles it as an ordinary
merge. To inspect or build the result in place, open `<data dir>\worktrees\<run>\integration` (or
`git switch` to the branch after removing that worktree with `runs.cleanup`: Git refuses to check a branch
out in two worktrees, and refuses to delete a branch that is checked out in one).

Afterwards, when you no longer need them, delete the branches yourself (`git branch -d nexus/<run>/integration`
and the task branches). NEXUS keeps them so nothing is lost.
