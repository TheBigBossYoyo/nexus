# Providers

NEXUS 0.6 removes the assumption that an agent is Claude. Claude stays the required, first-class provider. Any
other provider is optional, off until you enable it, and never needed: with nothing else installed or enabled,
NEXUS behaves exactly as it did before 0.6.

This document describes the 0.6 feature set as the code implements it. Source: `src/shared/provider.ts` (the
model and the routing decision), `src/main/modules/providers/` (discovery, the router, the Codex runtime),
`src/main/modules/ipc/v6-handlers.ts`, `src/renderer/src/views/providers/`.

## The providers

| Provider | Status in 0.6 | How it is reached | What it may do |
|---|---|---|---|
| Claude | Required | The Claude Agent SDK runtime NEXUS has always used, unchanged | Everything: plan, implement, review, verify |
| Codex | Optional | Its own command line tool (`codex exec --json`), with the login that tool already has | Read-only roles: review, research, critique. It changes no file |
| Gemini | Detected only | `gemini --version` | Nothing. NEXUS 0.6 has no runtime adapter for it and it cannot be enabled |

## Discovery

At startup, and when you press "Detect again", NEXUS asks each provider's own tool two things: its version and
its sign-in state. For Codex that is `codex --version` and `codex login status`.

- No credential file is opened, no token is read, no login is started. If a provider is not signed in, the page
  says so and tells you to sign in with that provider's tool. Of what the tool prints about its login NEXUS keeps
  only the kind ("ChatGPT login", "API key", "Signed in"); the line itself is not stored, because it could name
  an account.
- The tool is found on PATH and nowhere else, and is started by its absolute path. The directory a session works
  in is never searched, PATH entries inside it and relative PATH entries are ignored, and a tool found inside it
  is refused: a file named `codex.cmd` in a repository does not run. On Windows the shim is run by the system's
  `cmd.exe`, addressed by its absolute path.
- No prompt is sent. An optional provider that is installed and signed in is therefore shown as "Signed in, not
  yet used", not as "Connected", until a session has worked. Claude is shown as connected when its runtime
  reports an authenticated account. "Test" runs one minimal session ("Reply with the single word OK") and uses a
  little of that provider's quota. It is offered only for a provider you have enabled, runs only when you press
  it, and is not repeated within half a minute.
- A provider whose tool does not answer is a status ("Not installed", "Detection failed"), never an error of
  NEXUS. One provider failing detection does not affect the others.
- A Codex tool older than 0.124.0 is reported as detected and not supported.

Each provider has one state on the page:

| State | Meaning |
|---|---|
| Not installed | Its tool was not found on PATH |
| Detected, not supported | Installed, but NEXUS cannot run sessions with it (Gemini; an old Codex) |
| Authentication required | Installed, not signed in |
| Available, not enabled | Usable; NEXUS sends it nothing because you have not enabled it |
| Signed in, not yet used | Enabled; no session has run yet |
| Connected | The last session or test worked |
| Failing | One or two sessions failed in a row; it is still tried |
| Unavailable | Three sessions failed in a row, or a test failed. Not used until a test or a new detection succeeds |

## The provider policy

Nothing is sent to a provider you have not enabled. Enabling a provider sends it nothing by itself: a use must be
switched on too.

| Setting | Default | Effect |
|---|---|---|
| Allow NEXUS to use Codex | off | Without it no session ever goes to Codex |
| Cross-model review | off | Reviewer and security-reviewer sessions go to the chosen provider. Planning, implementation and verification stay with Claude |
| Heterogeneous speculation | off | In a speculative task, candidate B is written by the chosen provider. Only a provider that may change files can be chosen; Codex cannot in 0.6 (see below) |
| Fall back to Claude | on | When the chosen provider cannot be used, Claude does that session and the reason is recorded. Off: the session is refused with the reason |

The policy is validated when it is saved (`ProviderService.setPolicy`): a provider that is not installed, not
supported or not signed in cannot be switched on; a use cannot name a provider that is off, or Claude; candidate
B cannot be given to a read-only provider. Switching a provider off in the UI switches off the uses that named
it.

## Routing

Every agent session passes through one router (`ProviderService.router`), which is itself an `AgentRuntime`. The
orchestrator, the Arena, programs and workspaces start sessions exactly as before; they do not know about
providers. The decision is a pure function, `routeSession(request, policy, statuses)`:

1. A resumed session goes back to the provider that owns its session id. A session of another provider is
   resumed only while that provider is still enabled and usable; otherwise it is refused, never sent elsewhere.
2. Otherwise Claude is asked for, unless a use that is switched on names another provider for this role
   (cross-model review) or this agent (candidate B of a speculative task).
3. The named provider is used if it is enabled, installed, supported, signed in, not unavailable, and allowed
   to do what the role does (a role that changes files needs a provider that may write).
4. If it cannot be used: with fallback on, Claude runs the session and the reason is stored; with fallback off,
   the session ends at once with the reason and nothing is sent anywhere.

A Claude model name is never handed to another provider. The other provider gets the model named in the policy
for it, or NEXUS's default for it (`gpt-5.5` for Codex).

Every session is recorded in `provider_sessions` (migration 008): the run, the agent, the role, the provider
asked for, the provider that ran it, the model, the tool version, what the tool said about its login, the
reason, the fallback reason, the provider's session id, the outcome and the observed tokens. The mission
inspector shows the provider and model of every agent, and the Providers page lists the sessions that involved
another provider.

## Cross-model review

With cross-model review on, a mission runs like this: Claude implements a task, a reviewer from the other
provider reads the change independently, Claude verifies. The reviewer's answer goes through the same review
pipeline as a Claude review. A finding is a claim: it leads to a repair task that must pass the task's checks
and the verifier, as before. NEXUS does not treat agreement or disagreement between providers as evidence of
anything. Tests, source and the acceptance criteria decide.

## What a Codex session is, and is not

- **Read-only.** NEXUS starts Codex with its read-only sandbox (`-s read-only`, and
  `sandbox_mode=read-only` for a resumed session) and refuses to start it for a role that changes files. The
  sandbox is Codex's and is what keeps the agent from writing. NEXUS adds one check of its own: it fingerprints
  the working directory before and after (HEAD, the status of every path, the content of every change to a
  tracked file). The check fails closed: if the fingerprint cannot be taken (not a Git working tree, Git failed)
  the session does not start; if it differs or cannot be taken afterwards, the session is ended as an error, its
  result is discarded, and no further Codex session runs in that directory, so a second attempt cannot pass on
  the changed state. NEXUS does not undo the change.
  What the fingerprint cannot see: an edit inside a file that was already untracked, files ignored by Git,
  anything outside the working directory, and Git's own metadata other than HEAD.
- **It can read what you can read.** A read-only sandbox does not limit reading. A Codex agent can read files
  outside the repository, and what it reads can reach its provider. Content of a reviewed repository could ask
  it to. Enable Codex only for repositories whose content you would let it act on.
- **Its environment.** The tool runs with NEXUS's environment without the Claude credentials and Node options
  that NEXUS withholds from every project command.
- **Not under the NEXUS permission policy.** Tool calls of a Codex agent are not authorized one by one by
  NEXUS. The Codex sandbox confines it. The Providers page states this as "Confinement".
- **No NEXUS agent tools.** A Codex agent cannot send messages to other agents, report blockers or propose
  memory.
- **Structured output is prompted.** The JSON schema is given in the prompt and the last JSON object of the
  answer is parsed. An answer without JSON fails as "structured output failed", which the review pipeline
  handles like any failed session.
- **Per turn, not live.** One turn is one process, run through the same process runner as every other command
  NEXUS starts. Its events are read when it ends.
- **Its own failures.** An error from Codex, including its own usage limit, is an error of that session. It is
  never reported as a Claude usage limit, never pauses a run for quota and never closes the dispatch gate.
- **Command line safety.** The tool is started by its absolute path with a fixed argument list. Every argument
  is checked against a strict character set, a session id that could look like an option is refused, and the
  prompt goes through stdin, never through the command line.
- **A failing provider costs a review before Claude takes over.** Fallback is decided when a session starts. A
  Codex session that fails in the middle fails that review; after three failures in a row Codex is treated as
  unavailable and Claude does the next ones.

## Usage

Quota systems differ and NEXUS does not convert them into one scale.

- The Usage page is Claude's, as before. Events from an agent another provider ran (tokens, limits, starts,
  failures) are not recorded there and cannot change Claude's status.
- The Providers page shows, per provider, the plan windows exactly as that runtime reports them, or "not exposed
  by this runtime" (Codex), and the tokens NEXUS observed in that provider's sessions. No estimate is shown for
  a provider that reports no window.
- "Recent sessions" are counts (completed, failed, done by Claude instead). They are not a score or a ranking.

## Policy evidence and the Arena

A mission outcome and an Arena trial record which model ran each role. An agent another provider ran is recorded
as `<provider>:<model>` (for example `reviewer: codex:gpt-5.5`); in an Arena trial this replaces the Claude model
of the routing decision for that role. Evidence from missions with another provider's
reviewer is therefore never pooled with Claude-only evidence under a bare model name, and the existing
model-drift weighting treats a change of provider like a change of model. The sample thresholds of the adaptive
policy are unchanged: nothing is concluded from a few sessions. NEXUS 0.6 does not choose a provider by itself;
only the settings above route a session to another provider.

## Failure of an optional provider

An optional provider that is missing, signed out, too old, failing or slow never fails NEXUS. Sessions meant
for it are done by Claude (fallback on) or refused with the reason (fallback off), and the Providers page shows
the state and the last failure.

## IPC

| Channel | Purpose |
|---|---|
| `providers.overview` | Statuses, the policy, per-provider counts and usage, recent sessions |
| `providers.refresh` | Detect again |
| `providers.setPolicy` | Save the policy (validated as above) |
| `providers.probe` | One minimal real session with a provider |
| `providers.sessions` | The provider sessions of a run |

## Tests

- `tests/integration/providers/providers.test.ts`: the routing decision; command lines; the Codex runtime
  against a scripted process (events, resume, errors, structured output, the read-only check); discovery of each
  provider; the service with scripted Claude, Codex and Gemini providers (Claude-only operation, enabling,
  cross-model review, outage and recovery, authentication required, heterogeneous speculation, resume, usage
  isolation); migration 008.
- `tests/unit/renderer/providers-model.test.ts`: every sentence of the Providers page.
- `tests/e2e/v6.spec.ts`: the Providers page, enabling Codex and cross-model review through the UI, a mission
  whose reviews are done by the scripted Codex, and a provider that needs authentication.
- `pnpm smoke:providers` (manual): detects the real providers and, when Codex is installed and signed in, runs
  one real read-only review with it. Evidence is written to `docs/acceptance/providers-smoke-*.json`.

## Limits

- Codex is read-only in 0.6. Heterogeneous speculation with a real second provider is therefore not available;
  the path is implemented and tested with scripted providers only.
- Gemini is detected and nothing more.
- A Codex agent is outside the NEXUS permission policy and has no NEXUS agent tools.
- Health comes from the sessions NEXUS ran and from explicit tests. NEXUS does not poll providers.
- The default Codex model is a fixed name (`gpt-5.5`). If the installed tool or the account does not offer it,
  sessions fail with the tool's own message and the provider becomes unavailable; set another model in the
  policy (`models.codex`, through `providers.setPolicy`; the page has no field for it yet).
- NEXUS does not pick a provider from evidence. Provider identity is recorded with evidence; routing is by the
  settings only.
