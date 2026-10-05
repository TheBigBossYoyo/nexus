# Release trains (0.5)

A release train is a plan for releasing several repositories together after a cross-repository mission: which
repositories, in what order, with which version numbers, and from which branch and commit. NEXUS prepares the
plan. NEXUS does not publish it, and nothing in 0.5 can make it.

Prepared only. NEXUS does not publish; release the repositories yourself in this order.

That sentence is the statement the Release trains tab shows above every list of trains. A train's card repeats
it: "Publishing is not available."

Source: `planRelease` and `bumpVersion` in `src/shared/workspace.ts`; `releasePlanFor`,
`prepareReleaseTrain`, `publishReleaseTrain` and `cancelReleaseTrain` in
`src/main/modules/workspace/engine.ts`. See also [WORKSPACES.md](WORKSPACES.md),
[MULTI_REPO_ORCHESTRATION.md](MULTI_REPO_ORCHESTRATION.md) and [CONTRACTS.md](CONTRACTS.md).

## What a prepared train is

A `ReleaseTrain` row (`workspace_release_trains`) with:

| Field | Meaning |
|---|---|
| `missionId` | The workspace mission it was prepared from |
| `name` | `Release train of <the first 60 characters of the goal>` |
| `state` | `PREPARED` or `CANCELLED` |
| `plan` | The `ReleasePlan`: `steps`, `levels` and `problems` |
| `publishAuthorized` | Always `false`. The type is the literal `false` and the column defaults to 0 |

A train is prepared in two ways:

- Automatically, when a mission passes global verification and the plan has at least one step. A mission that
  does not verify prepares none.
- By you, with Prepare release train on a `COMPLETED` mission (`workspace.prepareRelease`). It is refused for
  any other state and for a mission with no stored verification. It computes the plan again from the
  repositories' facts as they are now and stores a second train; it does not replace the first. A mission with
  nothing to release yields a train with no steps.

## How `planRelease` orders steps and bumps versions

`planRelease` is a pure function. Its input, as the engine builds it for a mission:

- every enrolled repository with its key, its version, a branch, a commit and whether the mission changed it.
  The version is the one read from the repository's manifest at enrollment or at the last Refresh, not at the
  mission's result commit. The branch and commit are those of the newest completed task in the repository (the
  result branch and result commit). A repository is changed when it has such a commit,
- every edge of the organization graph (`from` depends on `to`),
- per provider repository, the strongest contract comparison level among the contracts it provides that the
  mission touched. The order of strength is `identical`, `compatible`, `unknown`, `breaking`.

### Order

The repositories are put in dependency order: a repository is released after every repository it depends on.
`levels` lists, in order, the groups that could be released at the same time; only repositories that are in the
train appear. Ties are broken by key.

If the graph has a cycle, no order exists: the plan has no steps and one problem saying so (the global
verification's `release order` check also fails on a cycle).

### Bumps

A repository is in the train when it gets a bump. Bumps are decided in this order, and the strongest wins
(`major`, then `minor`, then `patch`):

| Rule | Bump | Reason recorded on the step |
|---|---|---|
| The mission changed the repository | `patch` | Changed by the mission. |
| It provides a contract whose strongest level is `compatible` | `minor` | A contract it provides gained elements. |
| It provides a contract whose strongest level is `breaking` or `unknown` | `major` | A contract it provides changed incompatibly. |
| It depends on a repository that is in the train, and it has no bump yet | `patch` | Depends on `<repositories>`, released in this train. |

The last rule is applied in dependency order, so a chain of dependents is carried along: a repository that
depends on a repository that was bumped only because of its own dependency is bumped too. A repository that
was not changed by the mission can therefore be in the train; its step has no branch and no commit.

A provider with a contract change but no change of its own repository still gets the contract's bump.
`identical` contracts give no bump.

A step lists `after`: the repositories it directly depends on that are also in the train.

### Version numbers

`bumpVersion` reads the current version as `MAJOR.MINOR.PATCH` and returns `MAJOR+1.0.0` for `major`,
`MAJOR.MINOR+1.0` for `minor` and `MAJOR.MINOR.PATCH+1` for `patch`. There is no special case for `0.x`
versions: a major bump of `0.7.3` is `1.0.0`. Anything after the patch number (a suffix such as `-beta.1`) is
dropped on a bump. A version that is not of the form `MAJOR.MINOR.PATCH...` is returned unchanged, with no
problem reported.

A repository whose manifest has no version (`go.mod` has none; a repository with no manifest) has
`nextVersion: null`, and the plan has a problem: `<repository> has no version in a manifest; its release cannot
be numbered.` The train is still prepared.

### Example

From the integration test: a compatible change to a contract that `shared-sdk` provides, with `backend` and
`desktop` as consumers and every repository changed by the mission.

| Step | Current | Next | Bump | After |
|---|---|---|---|---|
| `shared-sdk` | 2.2.9 | 2.3.0 | minor | nothing |
| `backend` | 1.8.4 | 1.8.5 | patch | `shared-sdk` |
| `desktop` | 0.7.3 | 0.7.4 | patch | `backend`, `shared-sdk` |

## What the user is shown

The Release trains tab (`workspace-releases`):

- the statement above,
- per train: its name and state, when it was prepared and from which kind of source, the problems of the plan
  as a warning, and the steps in release order,
- per step: the repository, `current -> next` version with the bump (`No bump` is shown for `none`), the reason,
  what it comes `After` (or "nothing: it can go first"), its branch and its commit,
- Cancel train, for a prepared train.

The mission page has Prepare release train for a completed mission and then opens this tab.

## NEXUS never publishes

Publishing is not a missing feature that is switched off. It is something 0.5 does not have, and several
things keep it that way:

- The workspace policy field `publishing` accepts one value, `never` (`z.literal('never')`). The Policy tab
  shows it as text.
- `ReleaseTrain.publishAuthorized` is typed as the literal `false`, and the engine always stores `false`.
- The workspace engine contains no code that pushes, tags, publishes a package or opens a release. Its Git
  use is reading (`remote get-url`, `show`, `rev-parse`) and the orchestrator's own worktrees and branches.
- A mission only produces branches in the enrolled repositories. It never changes your branches.

### The publish channel

The channel `workspace.publishRelease` (input: a train id) exists and always refuses. Its result type is
`never`. When called, the engine records a decision of the kind `publish_refused` ("A request to publish a
release train was refused: NEXUS prepares releases and does not publish them.") and fails with the error:

> NEXUS prepares release trains and does not publish them. Publishing needs an explicit authorization that
> this version does not offer; release the repositories yourself, in the order shown.

It exists so that the refusal is explicit and on record rather than a missing channel. A caller that asks gets
a clear answer and the trail shows the request. An unknown train id gives `not_found` instead. The UI has no
button that calls it. `tests/integration/workspace/engine.test.ts` checks the refusal and the decision;
`tests/stress/workspace-stress.test.ts` checks that a request to publish is refused and that no train is ever
marked as authorized.

## Cancelling a train

Cancel train (`workspace.cancelRelease`) marks the train `CANCELLED`. It is a label on the plan. Nothing was
published, so nothing needs undoing, and no branch or version is touched. A cancelled train stays in the list.
Cancelling records a `release_cancelled` decision. Cancelling a train that is already cancelled changes
nothing.

## What you do next, by hand

NEXUS leaves the work on branches. For each step, in the order shown:

1. Look at the result. The step names the branch (the run's integration branch in that repository) and the
   commit. Review it as you would any branch (`git log`, `git diff`; see GIT_WORKTREES.md and "Where results
   end up" in the README).
2. Merge the branch into your own branch in that repository, yourself. NEXUS never merges into your branch.
   Do this for a provider before the repositories that depend on it, which is the order of the steps.
3. Set the version. The plan gives the next version; NEXUS does not edit any manifest. For a step with no
   branch and no commit (a repository only in the train because a dependency moved), the change you make is
   updating its dependency on the released repository.
4. Release with your own tooling (tag, package registry, deployment pipeline), and wait for the repository that
   others depend on to be available before you release its dependents.

A prepared plan is a proposal made at one moment. If the repositories changed after the mission (more commits,
a different version in a manifest), compare the plan with their current state before you follow it; Refresh the
repository in the Overview tab and prepare a new train to recompute.

## Limits

- The versions come from the manifest facts stored at enrollment or at the last Refresh. A version bumped by a
  task of the mission itself is not read back from the result commit.
- Only `MAJOR.MINOR.PATCH` versions are bumped. Pre-release and build suffixes are dropped, other formats are
  left unchanged without a warning.
- The order uses the organization graph, which only contains what manifests, contracts and you declared
  (WORKSPACES.md, Limits). A dependency nobody declared is not ordered.
- The bump from a contract comes from the comparison level, whose limits are in CONTRACTS.md. `compatible`
  means no breaking change was seen in what NEXUS reads.
- A manifest dependency that mentions a version range of the repository that moved is not updated or checked.
- Preparing a train a second time creates a second train. Cancelled trains are not deleted.
- Tests: `tests/unit/workspace/workspace-model.test.ts` (order and bumps, a breaking contract as a major
  release, a cycle with no release order, a missing version, version arithmetic),
  `tests/integration/workspace/engine.test.ts` (the example above, the refusal to publish, no train for a
  mission that did not verify), `tests/stress/workspace-stress.test.ts`.
