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
| 1.1 | HIGH | One 401 latches the capacity pool in AUTH_REQUIRED until a full browser sign-in; no token refresh or retry is tried, and the card still says "Connected" | | FIXED `7d2af7d`: one refresh and one more send after a 401; if either is refused the pool is held and the card reads as needing a sign-in. Four tests |
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
| 6.4 | HIGH | A program replan note is one slot: a second note before the replanner starts overwrites the first, the note is deleted when the replan budget is exhausted, and only the latest reaches the replanner; milestone missions never see it | | FIXED `8339119`: notes are a list; all pending ones reach the reassessment, all of them the following missions; a note is refused at once when the budget is used. Two tests |
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
| 14.4 | HIGH/MEDIUM | Shutdown: admission is closed first, then up to 30 s of other waits pass before the orchestrator sets a stop reason. A session started in that window ends stopped with no reason, which is read as crashed: the task fails and an attempt is consumed | | FIXED `a42bec2` by the order of the stop: admission closes after the orchestrator has given its sessions a stop reason. No test: the stop sequence of the runtime core has no harness below the runtime process |
| 14.5 | MEDIUM | Wait checkpoints go stale: the ENDED state is declared and never written; a crash or a failed write after a resume leaves a WAITING record that a later pause of the run re-reads; the loop has no per-run try, so one run whose resume throws starves the others every 2 s | | FIXED `1403123`: per-run try, leftover waits closed (ENDED is now written), a wait is marked before the resume and put back if it fails |
| 14.6 | MEDIUM | During an outage the recovery asks the runtime for the account every 2 s for every wait (a child process each time, no cache), and with fewer free slots than waiting runs it resumes them all | | FIXED `1403123`: the account answer is kept for 30 s; one run per pass |
| 14.7 | MEDIUM | After a hard kill of the runtime the old worker can still be alive for some seconds; the next start may resume the task on the same worktree while it runs (not reproduced) | | OPEN |
| 14.8 | MEDIUM | Seen once in three full runs of the suite, never in eleven runs alone: with a limit of 3 agents the control overview counted 4 active while a Program and an Arena campaign ran together. The kernel bounds engineering sessions at the limit (every session role maps to worker or reviewer), so the fourth is an agent row that waits for admission or is ending; if it waits, its run pauses for capacity and is resumed (see 4.4). The test now reports the breakdown when it fails | | OPEN |
| 14.8 | LOW | A handoff session that waits for capacity yields an empty handoff; with two advisory leases the workers have fewer slots than the scheduler assumes; a resume landing after the orchestrator shut down can start a planner that ends crashed | | OPEN |

## 5. Director architecture

Read-only review on 2026-10-10. Sound, from the code: `executionAuthorized` is only ever written false and the
repository refuses anything else; nothing consumes a Director's output but storage and the Director view; the
PENDING record and each validated stage are saved before the next call; a restart marks an interrupted request
FAILED with its completed stages and never replays it; a missing technical capability waits before any call and
does not lower the level; failure text is fixed text with no provider body; the technical session has no tools,
no MCP servers, no settings and denies every authorization.

| # | Sev | Finding | Checked | State |
|---|---|---|---|---|
| 5.1 | MEDIUM | An escalation that waited or failed is stuck: its state becomes WAITING_FOR_PROVIDER or FAILED, and both the invoke and the dismissal require REQUESTED. The message says "retry explicitly" and the retry is refused | | FIXED `01ebf97`: an escalation that waited or failed can be invoked again or dismissed. Test |
| 5.2 | MEDIUM | The PENDING record of a level 1 (Claude only) request carries provider `openai` and the ChatGPT model whenever ChatGPT is connected; after a crash the view shows a provider that was never called | | FIXED `01ebf97`: a level 1 request records no strategic provider |
| 5.3 | MEDIUM | The technical challenge is given the whole strategic memo: it challenges the proposal, it is not an independent assessment. The wording of the claim must say so | | OPEN |
| 5.4 | MEDIUM | A stage whose answer cites one evidence id outside the context is dropped whole, with its disagreements, although the call was paid for | | OPEN |
| 5.5 | MEDIUM | A Claude candidate is built for every advisory role, strategic included, and is admitted when quality evidence exists for it; the record has no field that says it was a fallback and why | | OPEN |
| 5.6 | LOW | The "quality evidence" of a primary provider is the policy label `PRIMARY_ROLE_POLICY`, not a measurement, and is written in two formats in two files | | OPEN |
| 5.7 | LOW | The technical session runs in the NEXUS data directory with the full coding system prompt; whether its transcript is persisted by the runtime is not established | | OPEN |
| 5.8 | LOW | A wait at the first stage reports consumption UNKNOWN where nothing was sent | | OPEN |
| 5.9 | LOW | The outcome record has no requested role, no fallback flag, no verification result and no later repairs: Director outcome learning has nothing to learn from yet | | OPEN |
| 5.10 | LOW | Account profile, pool overlay and model choice are computed separately in `production-routing.ts` and `worker-routing.ts` | | OPEN |

## 7. Task Compiler: prompt injection

Read-only review on 2026-10-10. Sound, from the code: the level, the scope and the criteria come from the user's
text only; a model cannot produce the provenance USER_EXPLICIT or USER_CONFIRMED (closed enumeration, strict
schema); evidence references must lie in what was retrieved; graph text and the instructions in force are
rendered through `oneLine` or `quoteBlock`; the instruction history is written by IPC handlers only; an agent
note stays AGENT_NOTE and is left out of high-risk retrieval; a compilation is at most four calls with bounded
input; the inspector renders text, the Markdown renderer is sanitized. What a talked-into worker can do is
bounded by the authorizer, the command classifier and the content inspector, not by prompt wording.

| # | Sev | Finding | Checked | State |
|---|---|---|---|---|
| 7.1 | MEDIUM | The compiler is given graph notes as title and summary without their trust word: an unverified agent note stands beside a verified fact, and can come back as a recommendation of provenance CONTEXT_DERIVED that needs no decision, in every planner and worker prompt of the run | | FIXED `8253cb5`: agent notes are not given to the compiler; what is given carries its type and trust word. Test |
| 7.2 | MEDIUM | READY rests on what the model reports (scope changed, ambiguities, decision needed); the drift check is asked of the same provider, and its code half is five patterns that know nothing of a new dependency, a secret file, disabled tests or a network call | | OPEN |
| 7.3 | LOW | In TECHNICAL and COUNCIL the synthesis replaces the output: a constraint or non-goal of the technical pass can be dropped. Decision flags and blockers accumulate and are not lost | | OPEN |
| 7.4 | LOW | `renderCompiledAdvice` serializes with no replacement of `<`, format characters or U+2028/2029, unlike `withAdmittedIntent` | | OPEN |
| 7.5 | LOW | The original request is rendered raw and unquoted when a specification exists; pasted third-party text reads as the user's own words (by design it is the user's authority) | | OPEN |
| 7.6 | LOW | Program memory enters reasoning prompts with no trust label; a heading line can appear inside the data block | | OPEN |
| 7.7 | LOW | Words such as "security" or "migration" in pasted text raise the level to COUNCIL (four calls); long evidence can push the output past the size that forces a decision | | OPEN |

## 8. Context Graph integration

Read-only review on 2026-10-10. Sound, from the code: the compiler's evidence comes from the graph only, so the
graph and the older stores cannot disagree for it; a referenced node that becomes stale, superseded or archived
makes the specification stale; nodes of another program are hidden from the compiler, the Director and the
tools; the inspector shows what was bound, not a fresh query.

| # | Sev | Finding | Checked | State |
|---|---|---|---|---|
| 8.1 | HIGH | An unverified agent note reaches a compiled specification unlabelled: the compiler's retrieval keeps every CURRENT node, a note of a mission outside a program is one, and the text sent on carries no trust word. The rule that keeps agent notes out of high-risk retrieval is not applied by the compiler (the same defect as 7.1, seen by a second reviewer) | | FIXED `8253cb5`, see 7.1 |
| 8.2 | HIGH | The planner's graph section is always retrieved at medium risk, with the widening to every current hazard and decision: agent notes and stale statements can steer the plan of a critical mission, where a task pack of the same mission would leave them out | | ACCEPTED as designed: in the planner's section an agent note is listed as `agent note` with the line "UNVERIFIED: an agent wrote this note; it is a lead to check, not a fact", and the saving measured in 0.7.1 came from the planner seeing the note of the mission before. A stricter rule for missions the user marks critical is not in 0.7.2 |
| 8.3 | MEDIUM | The compiler reads the graph whether or not the Context Graph technique is on, and with its own rules (CURRENT only) where task packs allow conflicted and stale statements | | OPEN |
| 8.4 | MEDIUM | A Program mission's planner prompt holds the goal, the milestones and the program memory in its body and again as graph nodes: only project memory is removed from the graph section | | OPEN |
| 8.5 | MEDIUM | A Program run is created before its mission row: graph reads in between see no program. Workspace runs read every workspace the project is enrolled in, not the mission's own. Neither was reproduced | | OPEN |
| 8.6 | LOW | The identity of a compilation covers the twelve best-ranked nodes: a note written by an agent can move the ranking and make a draft compiled earlier ask for a new preview | | OPEN |
| 8.7 | LOW | A context reference is a node id and a version, shown as such: the inspector cannot say which reference is superseded or gone, nor show what the model read | | OPEN |
| 8.8 | LOW | No test writes an agent note and reads the compiled context, makes a referenced node stale, or runs the compiler with the graph switched off | | OPEN |

## 9. Token Intelligence regression

Read-only review on 2026-10-10; nothing was measured on a provider. Unchanged from 0.7.1: role system prompts,
the tool list and descriptions, the token engine and the prefix registry; every addition is in the first user
message, after the cached prefix. A compilation is cached by identity.

Estimate for a mission of four tasks with a compiled specification: about 11,000 more input tokens for a request
of 2,000 characters, about 50,000 for one of 20,000.

| # | Sev | Finding | Checked | State |
|---|---|---|---|---|
| 9.1 | HIGH | With a compiled specification the request is rendered without the 8,000 character limit, and is added to every worker's first pack, which never carried it: a 20,000 character request is in the planner, every worker session and the mission verifier (32,000 is the only bound) | | FIXED `b66f758` for workers: their copy keeps the 8,000 character limit and says so. The planner and the mission verifier read the request whole, on purpose: they answer for all of it. Tests on size and on copies |
| 9.2 | HIGH | The compiled advice (up to 8,000 characters) is added to every worker pack, the planner and the mission verifier, although the planner has already turned it into tasks | | FIXED `01ebf97`: a worker reads the constraints, non-goals, risks and assumptions; the rest stays with the planner and the mission verifier. Asserted in the default-path scenario |
| 9.3 | HIGH | The default AUTO path costs two ChatGPT calls before planning, three for TECHNICAL and four for COUNCIL (chosen by common words), the last two with a Claude session on the strongest model; without ChatGPT a mission in AUTO cannot start | | OPEN |
| 9.4 | MEDIUM | A session that only waited for capacity writes a session-efficiency row with no turns, and the campaign runner counts it as a session | | OPEN |
| 9.5 | MEDIUM | Compiler and Director spend is kept only as receipts on routing records, with no run or mission, and appears nowhere in the Usage page | | OPEN |
| 9.6 | MEDIUM | `withAdmittedIntent` carries the raw text twice (as intent and as the first goal); Program and Workspace runs embed that blob in the run's prompt, which every later prompt repeats; the new sections are not itemized as pack entries | | OPEN |
| 9.7 | LOW | No test bounds the size of a prompt or the number of copies of the request in it | | FIXED `b66f758` for the worker pack and the planner prompt |

## 10. Privacy

Read-only review on 2026-10-10. Sound, from the code: EXACT and LIGHT send nothing to OpenAI; no file content, no
author name or address and no machine path is sent unless it is in a note or in the request; requests are sent
with `store: false` and at most 128 KB; no timer, analytics or update check was added; these modules log
nothing; removing a project removes its intelligence data through the foreign keys.

| # | Sev | Finding | Checked | State |
|---|---|---|---|---|
| 10.1 | HIGH | Consent: the only confirmation before project data goes to OpenAI is about billing. After the sign-in the next mission in the default AUTO mode sends the request, program and task text and graph notes, and no screen names OpenAI as their destination. There is no switch, per project or global, that keeps data away from OpenAI while signed in | | PARTLY FIXED `59c92f3`: the card, the compilation preview and docs/PROVIDERS.md say what is sent to OpenAI and when; the confirmation switch is described as what allows any sending (off: nothing is sent, signed in). A switch per project is OPEN |
| 10.2 | HIGH | No redaction: notes and workload text are sent unscanned. The filter on the classification `normal` filters nothing, because the graph writes `normal` on every node. A secret in a request, a note or an agent's summary goes to OpenAI, or to Claude through a council | | FIXED `59c92f3` for stored knowledge: entries sent as context go through the security log's redaction; agent notes are not sent (7.1). The user's own request is sent as written, which the card says. Test |
| 10.3 | MEDIUM | In COUNCIL and TECHNICAL, OpenAI's output goes to Claude and Claude's back to OpenAI, with no notice | | FIXED `59c92f3`: stated on the card and in docs/PROVIDERS.md |
| 10.4 | MEDIUM | The inspector shows the ids and versions of what was sent, not the text; nothing can be deleted short of removing the project | | OPEN |
| 10.5 | MEDIUM | README and docs/PROVIDERS.md do not name OpenAI as a destination; "Nothing is sent to a provider you have not enabled" does not cover it | | FIXED `59c92f3` in docs/PROVIDERS.md; the README gets its 0.7.2 section with the release report |
| 10.6 | LOW | The Claude and Codex account profile is a plain SHA-256 of address, organization and mode, kept in pool ids in SQLite: an address can be confirmed by guessing, locally | | OPEN |
| 10.7 | LOW | Routing records and checkpoints are never pruned | | OPEN |

## 13. Test quality

Read-only review on 2026-10-10. The verdict: each 0.7.2 subsystem is tested on its own, and the seams are faked
by hand. The capacity kernel and the real orchestrator meet nowhere below the built app; the scenario harness
has no admission layer (the new `v72-capacity` scenarios make the runtime emit the wait themselves); every test
that goes on to execute work passes EXACT, so the default AUTO path followed by a run is tested nowhere; the
fixtures grant what they then assert (an account that always has an address, quality evidence the test
recorded, capabilities the test set). Every defect found on 2026-10-10 sat at a boundary between two modules
each tested alone. No skip, only, fixme or added retry in the branch.

| # | Sev | Finding | Checked | State |
|---|---|---|---|---|
| 13.1 | HIGH | No scenario runs the real capacity kernel under the real orchestrator: an unexpected worker exit, a throw from the dispatch, a wait followed by a resume are tested with a hand-made stand-in on one side or the other | | FIXED: `tests/scenarios/v72-capacity-kernel.test.ts`, the scenario harness with the production admission in front of the scripted runtime: a mission to its end, a worker that dies, a wait while another consumer holds the slot and its recovery |
| 13.2 | HIGH | The default path (AUTO, then a run) is exercised nowhere end to end: with no ChatGPT one e2e asserts the form is blocked; with ChatGPT connected, nothing | | FIXED `01ebf97` below the built app: `tests/scenarios/v72-default-path.test.ts` creates a mission through IPC in the default depth with a scripted strategic provider and the real orchestrator carries it out; with no connection nothing is created. With the real provider it is part of the real acceptance, not done |
| 13.3 | MEDIUM | No contract test holds the real provider adapters' capability flags against what admission requires (the Codex defect) | | OPEN |
| 13.4 | MEDIUM | The paid-credit rule and the admission rule are tested as refusals on the main path only; lease accounting has no test with a forced unexpected exit | | PARTLY FIXED: the forced unexpected exit is covered by the scenario of 13.1. The refusals on secondary paths are OPEN |
| 13.5 | MEDIUM | Untested pairs most likely to hide a defect: capacity wait with the queue; with crash recovery; AUTO with plan approval and a stale specification; a ChatGPT 401 or quota with an overnight run; a resumed run with the Context Graph | | OPEN |
| 13.6 | LOW | Assertions that confirm a stub (`status` READY after a stubbed answer), existence only (`toBeTruthy` on ids) or a call count (fifteen in workload-admission) | | OPEN |

## Reviews not finished

11 UI/UX and 12 accessibility, after the UI work.

## Count on 2026-10-10, after twelve of fourteen reviews

First six reviews: 1 CRITICAL, 10 HIGH (two of them one defect seen twice), about 25 MEDIUM, the rest LOW.
Second six reviews: no CRITICAL; HIGH 8.1 (with 7.1), 8.2, 9.1, 9.2, 9.3, 10.1, 10.2, 13.1, 13.2.

Fixed, each with a test unless its row says otherwise: the CRITICAL (6.1); the HIGH findings 1.1, 3.1, 3.2,
4.1, 4.2, 6.2, 6.4, 8.1, 9.1 (workers), 10.2, 13.1, 14.1, 14.2, 14.3, 14.4; 6.3 for the mission planner; and
the MEDIUM findings 3.3, 3.7, 4.5, 7.1, 10.3, 10.5, 14.5, 14.6. 8.2 is accepted as designed.

Open and HIGH:

- 6.3, the workspace half: the workspace planner's read-only run reads the checkout.
- 9.3: the default AUTO depth costs two to four provider calls before planning. This is what the feature is;
  what is open is that nothing measured says the 0.7.1 saving survives it. The release report may not claim it.
- 10.1: no switch per project.

0.7.2 cannot pass its gate while a CRITICAL or a HIGH that contradicts a release claim is open.
