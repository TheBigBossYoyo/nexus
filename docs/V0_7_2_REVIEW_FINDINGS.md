# NEXUS 0.7.2: findings of the independent reviews

Started 2026-10-10 on the reconciled branch (`3fcd1e0`, the released 0.7.1 merged in). Each review was done
by a separate reviewer that was given the code and the question, read-only, and no conclusion. A finding is
listed as the reviewer reported it; "checked" says whether its decisive claim was verified against the code
before acting on it. State: OPEN, FIXED (with the commit), ACCEPTED (with the reason), or REJECTED (with the
evidence).

Severity is the reviewer's unless a note says it was changed and why.

## 1. OpenAI / Sign in with ChatGPT: correctness

Nothing CRITICAL. The paid-credit rule holds on every path the reviewer found: the confirmation is stored
per profile in the encrypted credential file, defaults to false, is reset on connect, disconnect and by the
saved schema, and every inference call site goes through one provider factory that requires it.

| # | Sev | Finding | Checked | State |
| --- | --- | --- | --- | --- |
| 1.1 | HIGH | One 401 latches the capacity pool in AUTH_REQUIRED until a full browser sign-in; no token refresh or retry is tried, and the card still says "Connected" | | OPEN |
| 1.2 | MEDIUM | Local or deterministic failures (output that is not JSON, a schema error on a usage field, an oversize request, a refresh network error, a shutdown abort) are recorded as provider capacity failures with a 5 minute to 6 hour backoff | | OPEN |
| 1.3 | MEDIUM | A pending sign-in cannot be cancelled: every button is disabled for up to 600 s after the browser tab is closed | | OPEN |
| 1.4 | MEDIUM | A storage fault or an undecryptable credential file cannot be recovered inside the app; one transient write failure makes it stick until restart | | OPEN |
| 1.5 | MEDIUM | Error classification is coarse: 403, 404 / model not on this plan, 400, 5xx and insufficient quota are all RUNTIME_UNAVAILABLE, and a stream-level rate limit is not THROTTLED; a permanent error reads as retryable | | OPEN |
| 1.6 | MEDIUM | The saved model is never reconciled with the catalog; a removed model is sent and fails as "runtime unavailable" | | OPEN |
| 1.7 | LOW | A completed response whose usage fails the strict parse throws after the generation was produced; the receipt is lost (reported UNKNOWN, not invented) | | OPEN |
| 1.8 | LOW | Connecting the same account twice creates duplicate profiles with separate capacity pools | | OPEN |
| 1.9 | LOW | The loopback listener closes all connections right after answering; the browser can show a reset on a successful sign-in | | OPEN |
| 1.10 | LOW | A refresh response without a refresh token wipes the credentials (right only if the server always rotates) | | OPEN |

Not reviewed by this reviewer: the tests; the wire protocol against OpenAI's own documentation (no network).

## 2. OAuth and credential security

Verified sound by the reviewer, with the enforcing lines: PKCE S256, state and nonce; an exact loopback
redirect bound to 127.0.0.1 on an ephemeral port, single use; the ID token (RS256, key by `kid`, issuer,
audience, nonce, times); fixed hosts with `redirect: 'error'` on every request; no plaintext fallback; no
token in SQLite, events, the graph, IPC results, logs or error text; the runtime endpoint.

| # | Sev | Finding | Checked | State |
| --- | --- | --- | --- | --- |
| 2.1 | MEDIUM-HIGH | The credential file is not on the agents' denylist, and agents inherit `NEXUS_DATA_DIR`, so code an agent writes can locate it through the environment without spelling a denied path; the file is protected by the user's own DPAPI key, which code running as the user can use | yes: `power-patterns.ts:63`, `claude-sdk-runtime.ts:122`, `desktop.ts:118` | FIXED `abbcc69`: the variable is withheld from every agent environment, and the denylist names the file and the variable. Residual: code that already knows the absolute path by other means is stopped by the path rules only |
| 2.2 | LOW | The `0o600` mode does nothing on Windows; the file relies on DPAPI and the profile ACL (the endpoint file is narrowed with `icacls`, this one is not); failed commits can leave `*.tmp` ciphertext | | OPEN |
| 2.3 | LOW | On reconnect the previous ID token goes into the authorize URL (`id_token_hint`), so into browser history | | OPEN |
| 2.4 | LOW | Revocation is best effort; disconnect clears local credentials even when revocation failed (the UI says so) | | OPEN |
| 2.5 | LOW | The ID token of a refresh response is not validated (it is not used) | | OPEN |

Not verified by this reviewer: whether the shell classifier denies a read through an unresolved variable
path; whether a support bundle omits the credential file; the content of the test fixtures.

## 3. Provider capacity accounting

Verified sound by the reviewer: there is no await between the decision, the claim and the dispatch, so a
double admission by interleaving is impossible; a routing decision can be claimed once; a claim that fails on
its second pool releases the first in one transaction; lease history is pruned on the next claim, so the
record limits cannot be reached; changing the agent limit does not strand admitted work.

| # | Sev | Finding | Checked | State |
| --- | --- | --- | --- | --- |
| 3.1 | HIGH | A Codex pool that is once marked QUOTA_PAUSED or AUTH_REQUIRED never becomes admissible again: only Claude pools are refreshed from observations, and only OpenAI pools are probed | | FIXED `fix: a paused pool of a provider with no probe` : a pause holds until its reset time, or 15 minutes with none (2 for authentication), then the pool is unknown again, labelled as local reckoning |
| 3.2 | HIGH | When the dispatch itself throws (a missing CLI), the leases are quarantined with no handle to confirm the stop, and stay held for the life of the process; the same shape exists in the advisory lane when the adapter cannot be created | | FIXED `edc5577`: no handle means nothing was started; the leases are released. The same in the advisory lane |
| 3.3 | MEDIUM | An exception while releasing in the `finally` block leaves the leases HELD, skips the outcome record and ends the event stream without `session.ended` | | FIXED `edc5577`: a failed release no longer takes the terminal event and the outcome with it; the leases are settled on the next pass |
| 3.4 | MEDIUM | Claude observations are applied to whatever account profile is current: after an account switch, the limits of account A can be written into the pool of account B | | OPEN |
| 3.5 | MEDIUM | Truthfulness of facts: a reset time and a utilization are stamped as observed now when the observation is older; a percentage kept across later events is shown as fresh; a retry time from local policy is stored as provider-reported; a concurrent observation can be overwritten by a stale copy | | OPEN |
| 3.6 | MEDIUM | HTTP leases of an earlier start are reclaimed only at boot; with a reused process id the single OpenAI slot stays quarantined until the next restart | | OPEN |
| 3.7 | MEDIUM | Recovery assesses every waiting session against the same free slot and resumes them all; all but one wait again, every 2 s | | FIXED `1403123`: one run is resumed per pass |
| 3.8 | LOW | After a quota or authentication refusal the routing record stays WAITING with no outcome, although a request was sent | | OPEN |
| 3.9 | LOW | Advisory leases are not capped at the advisory reserve; a clock jump can stall or shorten the settle interval of lease reclamation (the processes must still be gone) | | OPEN |

## 4. Routing and failover

Verified sound by the reviewer: only the requested provider gets the primary-role evidence; a stand-in needs
a registry entry keyed by provider, model, role, profile, policy version and runtime version; nothing in
production can write quality evidence (so no substitution ever happens today); a writing role never goes to
a provider without writes; a resumed session only considers its owner; `recover` cannot resume a user pause
and cannot resume twice.

| # | Sev | Finding | Checked | State |
| --- | --- | --- | --- | --- |
| 4.1 | HIGH | A Program is blocked when its current run pauses for capacity: `limited()` knows only the quota pause | yes: `program/engine.ts:533`, `:1289` | FIXED `edc5577`, with a test on the Program engine |
| 4.2 | HIGH | A Workspace mission is blocked the same way | yes: `workspace/engine.ts:846`, `:958`, `:1136` | FIXED `edc5577`, with a test on the Workspace engine |
| 4.3 | MEDIUM | Overnight treats a capacity pause as an unknown pause: no wait row, phase "paused", and the stall watchdog may finalize it blocked (the reviewer did not read the watchdog) | yes for the quota-only branches: `overnight/supervisor.ts:588`, `:672`, `:1012` | FIXED `edc5577` for the stall watchdog: a capacity wait is not a stall. The workload phase still reads "paused", not a wait of its own: OPEN as a display matter |
| 4.4 | MEDIUM | Waiting is run-wide, not provider-scoped: one session's wait pauses the whole run. Recovery runs every 2 s with no backoff, and a resume that waits again creates an agent row, a routing record and a checkpoint each time | | PARTLY FIXED `1403123`: growing delay per run, one run per pass. Waiting is still run-wide, not per session: OPEN, see the note below |
| 4.5 | MEDIUM | Some waits can never resume: a capacity pause raised where no wait checkpoint was written (planning, verification, consensus), and a resumed session whose owner is unknown or uninstalled | | FIXED `1403123`: a capacity-paused run with no wait on record is tried like the others; a session whose provider is not on record fails instead of waiting |
| 4.6 | MEDIUM | The durable wait record has no provider, reason or reset time; the run-level text names no provider | | OPEN |
| 4.7 | LOW | A repair or a rotated session is routed by role policy and nothing links its provider to the work it repairs | | OPEN |

Note on 4.4, run-wide waiting. One session that finds no provider pauses its whole run, so work of the same
run that another provider could take stops with it. Other runs are not affected: blocked capacity is scoped
to the provider across runs, not across the sessions of one run. Making it per session means the scheduler
must hold one task while it dispatches the others, which is a change to the scheduler's core and to every
engine that reads a run's state. It is recorded as a limitation of 0.7.2, not fixed.

## 6. Task Compiler: intent preservation

Verified sound by the reviewer: the raw text is stored and compared byte for byte, with a database trigger
that aborts an update; EXACT makes no model call; AUTO is a pure function of the text and its metadata, so
it cannot change between preview and start; malformed or out-of-scope model output is never saved; a spec
that waits for a provider or a decision can neither be bound nor started; stale context fails validation;
internal work (planner tasks, repairs, graph proposals, milestones, per-repository tasks, background jobs)
never compiles; the owner of an engineering entity cannot be set through IPC.

Entry points. Admitted: `runs.create` (not for mode ask, which is read-only), `overnight.start`,
`runs.replan`, `tasks.add`, `tasks.instruct`, `tasks.resolveBlocker`, `criteria.update`, `program.create`,
`program.start`, `program.replan`, the workspace mission and program channels, and the queue, schedules and
overnight starters (they reference existing drafts and validate at start). Admitted only when a selection is
passed: `runs.resume`, `recover(resume)`, `program.resume`, the workspace resumes. Not admitted: `memory.add`,
`knowledge.writeNote`, `workspace.addMemory`, the note of `approvals.resolve`.

| # | Sev | Finding | Checked | State |
| --- | --- | --- | --- | --- |
| 6.1 | CRITICAL | A rotated worker loses the earlier instructions: the prompt that resumes from a handoff holds the task, its criteria and the model-written handoff, and not the admitted history, the original request or the mission criteria. "Never touch the public API" survives a rotation only if the handoff happens to restate it | | FIXED `dc8e0a8`: `orchestrator/instructions.ts`; the resume from a handoff carries the request, every amendment and the mission criteria |
| 6.2 | HIGH | A repair worker is a new child task whose prompt gets only the instructions not yet delivered to its parent; the history is keyed on the parent and never read. Reviewer and verifier prompts have no admitted-request input, so no reviewer can flag a violated instruction | | FIXED `dc8e0a8`: a repair, the reviewer, the verifier and the mission verifier are given the instructions in force; a child task's pack carries its parent's |
| 6.3 | HIGH | Snapshot: the mission planner runs in the live checkout while the spec, the base commit and the workers' worktrees are at the admitted commit. If the checkout moves during planning, a pause or a wait, the plan is written against the new state and executed on the old. The workspace planner's read-only run has no base reference either | | PARTLY FIXED: the mission planner reads the run's integration worktree at the base commit, with a test that moves the checkout while it plans. The workspace planner's read-only run still reads the checkout: OPEN |
| 6.4 | HIGH | A program replan note is one slot: a second note before the replanner starts overwrites the first, the note is deleted when the replan budget is exhausted, and only the latest reaches the replanner; milestone missions never see it | | OPEN |
| 6.5 | MEDIUM | The instruction history is an unbounded transcript, not a current state: every amendment is concatenated with no cap, each carries the raw text twice, and order is first-seen when a cached spec is reused | | PARTLY FIXED `dc8e0a8`: the new section is bounded, each instruction once, what is cut is counted. The older "Admitted user task requests" section of a worker's first pack is unchanged: OPEN |
| 6.6 | MEDIUM | Accepted text is cut silently later: replan feedback accepted to 10,000 characters and cut to 6,000 in the planner prompt; the request accepted to 20,000 and cut to 8,000 for the critic, the synthesizer and the audit; a task description accepted to 20,000 and cut to 8,000 | | OPEN |
| 6.7 | MEDIUM | An amendment is bound before the action takes effect: if the orchestrator then refuses, the history keeps an instruction that never applied | | OPEN |
| 6.8 | MEDIUM | Free text that changes worker prompts with no admission or provenance: memory, knowledge notes, workspace memory, an approval's note; the suggested files of an added task | | OPEN |
| 6.9 | MEDIUM | Drift detection is five patterns plus a self-check by the same provider; nothing sets or reads USER_CONFIRMED, so "the user confirms" can only mean a block | | OPEN |
| 6.10 | LOW | An EXACT spec carries no repository dependency; a resume without a selection re-checks neither provider configuration nor context | | OPEN |
| 6.11 | LOW | Every preview inserts a raw-intent row, cache hits included; a lone surrogate would be stored as U+FFFD and then fail validation | | OPEN |
| 6.12 | LOW | A program's later milestone runs on the branch tip while the spec's repository version is the base commit of the start | | OPEN |

Not verified by this reviewer: the workspace program resume; the program planner's base reference; the
consensus and speculation prompts; the renderer flows; the tests (none covers rotation or repair with instructions).

## 14. Scheduler and recovery consistency

Verified consistent by the reviewer: an admitted routing record is marked interrupted at boot; a held lease
is quarantined at boot and freed only after its owner and worker processes have been gone for 30 s, with the
first pass before the worker records are closed; a run paused for capacity survives a restart and is resumed
when capacity returns; lease release never meets a closed database at shutdown. No assertion of the
scenario, runtime or stress tests was relaxed in this branch (the only change is the EXACT compilation mode
on four calls, which means those kill-and-restart scenarios do not exercise the Task Compiler path).

| # | Sev | Finding | Checked | State |
| --- | --- | --- | --- | --- |
| 14.1 | HIGH | A slot leaks for the life of the runtime after an unexpected worker exit: `onExit` ends the session as crashed and never sets the stop as confirmed (only `failWorker` does), so the lease is quarantined and nothing can confirm it. Also when no worker could start or the grant failed. After a few such exits every session waits | | FIXED `edc5577`: a worker's exit confirms the stop of its session, as does a session that never reached a worker |
| 14.2 | HIGH | A capacity wait consumes a task attempt: the end reason `capacity` is not resumable, so every resume counts as a new attempt (a quota wait does not). After a few waits the first real failure gives up, and the model tier is escalated from the second attempt | | FIXED `edc5577`: a session that only waited keeps the task's attempt; scenario test with three waits |
| 14.3 | HIGH | Programs and workspace missions block on a capacity pause (as 4.1 and 4.2). Related race: the engines resume a capacity-paused run themselves while the recovery timer does too, and `resumeRun` checks the state once, awaits, then sets it; two resumes of a planning run can start planning twice | partly: see 4.1, 4.2 | FIXED `edc5577`: see 4.1 and 4.2; the engines no longer resume a capacity-paused run themselves |
| 14.4 | HIGH/MEDIUM | Shutdown: admission is closed first, then up to 30 s of other waits pass before the orchestrator sets a stop reason. A session started in that window ends stopped with no reason, which is read as crashed: the task fails and an attempt is consumed | | OPEN |
| 14.5 | MEDIUM | Wait checkpoints go stale: the ENDED state is declared and never written; a crash or a failed write after a resume leaves a WAITING record that a later pause of the run re-reads; the loop has no per-run try, so one run whose resume throws starves the others every 2 s | | FIXED `1403123`: per-run try, leftover waits closed (ENDED is now written), a wait is marked before the resume and put back if it fails |
| 14.6 | MEDIUM | During an outage the recovery asks the runtime for the account every 2 s for every wait (a child process each time, no cache), and with fewer free slots than waiting runs it resumes them all | | FIXED `1403123`: the account answer is kept for 30 s; one run per pass |
| 14.7 | MEDIUM | After a hard kill of the runtime the old worker can still be alive for some seconds; the next start may resume the task on the same worktree while it runs (not reproduced) | | OPEN |
| 14.8 | LOW | A handoff session that waits for capacity yields an empty handoff; with two advisory leases the workers have fewer slots than the scheduler assumes; a resume landing after the orchestrator shut down can start a planner that ends crashed | | OPEN |

## Reviews not started

5 Director architecture; 7 Task Compiler prompt injection; 8 Context Graph integration; 9 Token Intelligence
regression; 10 privacy; 13 test quality. 11 UI/UX and 12 accessibility after the UI work.

## Count on 2026-10-10, after six of fourteen reviews

Found: 1 CRITICAL, 10 HIGH (two of them one defect seen by two reviewers), about 25 MEDIUM, the rest LOW.

Fixed the same day, each with a test: the CRITICAL (6.1) and the HIGH findings 3.1, 3.2, 4.1, 4.2, 6.2, 14.1,
14.2, 14.3; 6.3 for the mission planner; and the MEDIUM findings 3.3, 3.7, 4.5, 14.5, 14.6.

Still open and HIGH: 1.1 (one 401 latches ChatGPT until a browser sign-in), 6.4 (a program replan note is
one slot), 14.4 (sessions started during shutdown end as failures), and the workspace half of 6.3.
0.7.2 cannot pass its gate while a CRITICAL or a HIGH that contradicts a release claim is open.
