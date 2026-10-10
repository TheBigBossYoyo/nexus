# Context lifecycle

How an agent's context is built, grows, is trimmed and is replaced, and what guarantees hold at each step.
Related: `CONTEXT_ENGINE_V3.md`, `TOKEN_INTELLIGENCE.md`, `PROMPT_CACHING.md`.

## 1. A session starts fresh

Every agent session is new. A task's worker does not inherit the planner's conversation, a reviewer does not
inherit the worker's, a repair does not inherit the failed attempt's. Continuity is carried by structured
records, never by a transcript:

| Carried | As |
| --- | --- |
| The task and its criteria | the pack |
| What dependencies produced | their result summaries |
| Decisions | recorded decisions |
| A review's outcome | its accepted findings |
| A failure | the check output, failures first |
| What a rotated session did | the handoff |
| Project knowledge | facts, memory, the Context Graph |

## 2. The first message

Built by the Context Engine (`CONTEXT_ENGINE_V3.md`). Stable text comes from constants; nothing in the role
prompt varies between requests. The first message carries what is specific to the task.

## 3. While it runs

The runtime owns the conversation. Each model request re-sends the history, mostly from cache. NEXUS records
each request (`cache_events`) and, at the end of each turn, the composition of the context
(`token_request_breakdowns`).

What grows a context: tool results (file reads, command output) and the model's own text. NEXUS keeps both
outside the context as well:

| Content | Stored in |
| --- | --- |
| Every tool call and a preview of its result | `tool_events` |
| Agent output | `agent_output` |
| Check command output, complete | the check results of the run |
| Diffs | git, on the task branch |
| Messages, decisions, reviews, verifications | their tables |

So anything removed from a model's context is still retrievable. Removing from context is never deleting.

## 4. Results in NEXUS's own prompts

When NEXUS puts a result into a prompt (check output into a review, a verification or a repair), it applies
progressive disclosure:

| Level | What | |
| --- | --- | --- |
| 1 | status and counts | `summarizeOutput` |
| 2 | failures first, then the tail | `filterOutput`, default `superset` |
| 3 | the complete output | stored; the prompt says how many lines exist and that the output is stored |

A result is in one of four states (`resultState`):

| State | Meaning | May be left out of a prompt |
| --- | --- | --- |
| PINNED | an unresolved failure or finding | no |
| ACTIVE | recent and in use, or not stored anywhere else | no |
| RETRIEVABLE | stored, and a later result exists | yes |
| STALE | superseded by a later result of the same kind | yes |

A result that is not stored is never RETRIEVABLE or STALE: what cannot be read again is not removed.

## 5. Tool-result clearing

The Claude API's context editing (`clear_tool_uses`) cannot be set by a host through the Agent SDK. Claude
Code clears old tool results by itself and counts the cache rebuild that follows as expected. NEXUS does not
add a second mechanism. Its part is section 3: the results are stored before anything is cleared.

When a session's context is above 70% and more than half of it is tool results, the session-efficiency
decision is CLEAR_STALE_TOOL_RESULTS. It is a record of the condition, not an action NEXUS performs.

## 6. Compaction

Server-side compaction is the runtime's. It triggers near the auto-compact window, summarizes earlier
history and continues. NEXUS does not write its own summarizer.

- Every compaction is recorded (`compaction_events`) with the trigger and the sizes before and after, and as
  a COMPACT decision with the observed difference.
- Nothing has to be saved by the model before a compaction. The requirements, acceptance criteria,
  decisions, commits, check results and unresolved findings are in the NEXUS database; the next prompt NEXUS
  builds (a repair, a review, a handoff resume) is composed from them, not from the conversation.
- What a compaction can lose is the session's own working detail between NEXUS's records. That is the
  runtime's summary to keep; NEXUS does not see it.
- No session in the 0.7.0 baseline compacted: sessions run 3 to 16 turns and are rotated at a turn limit.
  Compaction fidelity with real sessions is therefore NOT VERIFIED in this release.
- Background compaction is not a host control.

## 7. Rotation and the handoff

A session that reaches `sessionRotationTurns` is asked for a structured handoff and ends; a fresh session
starts from the handoff and the task.

The handoff (`HandoffSchema`): completed work, commits, files changed, unresolved issues, important findings
with evidence, next steps. The resume prompt adds the task, its criteria and the worktree. Raw evidence stays
in the database and in git; the successor is told to check the worktree state first.

What a rotation costs: the conversation cache of the old session is abandoned, and the new session pays for
its first message. What it buys: a small context. So rotating a session whose context is still small is a
loss. With "Rotate sessions by context pressure" on, such a session is continued instead and a session
above 85% is rotated; off (the default), the turn rule of 0.7.0 applies unchanged. The decision and its
reason are recorded either way (`session_efficiency`).

Tested with the scripted runtime: the handoff reaches the successor with the task's criterion and next
steps; a small session is continued under pressure rotation. A comparison of an uninterrupted session with a
rotated one on real work is NOT VERIFIED.

## 8. Context pressure

`pressureOf(contextTokens, windowTokens)`: LOW below 50%, MODERATE from 50%, HIGH from 70%, CRITICAL from
85%.

| Pressure | Effect |
| --- | --- |
| LOW | none |
| MODERATE | the graph budget of a prompt built into that context is 75% |
| HIGH | 50% of the budget; stale tool results are reported as clearable |
| CRITICAL | when the session ends: rotate with a handoff when one can carry the work. Inside a running session the runtime compacts; NEXUS does not interrupt it |

Risk overrides pressure: for a high-risk task the graph budget is widened and is not narrowed.

In 0.7.1 every pack starts a fresh session, whose context is empty, so packs are built at LOW pressure and
the narrowing in the first two rows is exercised only by unit tests of `allocateBudget`. Pressure acts in
practice at the end of a session, through the session-efficiency decision.

## 9. Between agents

Messages between agents are short structured facts with a subject, routed by NEXUS. A reviewer gets the
requirements, criteria, diff, check results and the subjects of messages the task sent, never the worker's
reasoning. A verifier gets TaskEvidence: records from the database, with agent-written text quoted and
marked as claims. With the graph on, an agent can refer another to a node by its path instead of copying
text.

## 10. Thinking

Thinking blocks belong to the runtime and the model. NEXUS never edits or removes them and never lowers
effort or disables thinking to save usage. Thinking tokens are counted inside output tokens.

## 11. What is recorded, in one place

| Table | One row per |
| --- | --- |
| `context_packs`, `context_pack_entries` | pack, and each candidate with the reason it was included or left out |
| `prompt_prefixes` | distinct prefix |
| `cache_events` | model request |
| `token_request_breakdowns` | turn end |
| `compaction_events` | compaction |
| `session_efficiency` | session end |
| `context_optimization_decisions` | context decision |
| `artifact_context_refs` | result placed in a prompt by reference (reserved; see the release report) |
