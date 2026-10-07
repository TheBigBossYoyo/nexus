# Token intelligence

Added in 0.7.1. Code: `src/main/modules/token`, `src/shared/token.ts`. Research and measurements:
`TOKEN_OPTIMIZATION_RESEARCH.md`, `V0_7_1_BASELINE.md`, `V0_7_1_RELEASE_REPORT.md`.

## The rule

Quality first. NEXUS removes wasted tokens, not reasoning. A technique is on by default only when it loses
no information, or when a controlled comparison showed quality equal or better. Nothing here changes a
model, lowers effort, turns thinking off, or reduces agents, reviewers or planning depth.

Three kinds of number exist and are never mixed:

| Basis | Meaning |
| --- | --- |
| exact | Counted by the runtime for that text (a `full` context breakdown) |
| observed | Reported by the runtime for a request (input, cache read, cache write, output) |
| estimated | Characters / 4, or the runtime's own estimate (a `summary` breakdown) |

## The engine

`TokenIntelligenceEngine` (`token/engine.ts`). The AdaptivePolicyEngine decides strategy; this decides only
how a session's context is carried, and records what the runtime reports.

```
task
 → context requirements          (Context Engine: what the task needs)
 → Context Graph navigator       (map, branches)
 → Context Graph retriever       (path, edges, full text; widen on low confidence or risk)
 → prefix plan                   (what decides whether the prefix can be shared)
 → tool plan                     (which tool definitions are in the prompt)
 → [the session runs]
 → token accounting              (per request, per session)
 → session efficiency            (keep, or hand off and rotate)
 → quality guard                 (a default changes only on evidence)
```

| Call | When | Does |
| --- | --- | --- |
| `planSession` | before a session starts | builds the session's context options and prefix identity; records the decisions |
| `attachPack` | with the pack | lets the breakdown name the pack's sections |
| `sessionStarted` | runtime reports provider and model | registers the prefix; drops Claude options for a provider without them |
| `requestUsage` | every model request | records a cache event; diagnoses the first request |
| `contextUsage` | end of every turn | records the breakdown of the context |
| `compaction` | runtime compacted | records sizes |
| `turnEnded` | a session ended | records the session-efficiency decision |

Accounting never fails an agent: every write is guarded and a failure is logged.

## Request component accounting

"Why did this request contain 54,318 tokens?" is answered by a `RequestBreakdown`: components that sum to the
runtime's total.

Components: SYSTEM_CORE, SECURITY_POLICY, ROLE, TOOL_DEFINITIONS, PROJECT_FACTS, CONTEXT_GRAPH,
REPOSITORY_CONTEXT, TASK, ACCEPTANCE_CRITERIA, DEPENDENCY_HANDOFF, MESSAGES, HISTORY, TOOL_RESULTS, MEMORY,
REVIEW_FINDINGS, DYNAMIC_RUNTIME_STATE, THINKING_HISTORY, OTHER.

Two sources are combined:

- the runtime's `getContextUsage()`: system prompt, built-in and MCP tool definitions, memory files, and the
  conversation split into tool calls, tool results, assistant text and user text;
- NEXUS's estimate of its own text inside those figures: the role prompt inside the system prompt, and the
  pack's sections inside the user messages.

NEXUS's estimates only split a runtime figure; what they cannot explain stays in the runtime's category, so
the components always add up to the runtime's total.

`contextUsageDetail` (Settings, Tokens): `summary` (default), `full`, `off`. Measured on the real runtime, a
`summary` breakdown is the runtime's own estimate and can differ a lot from what a request processed (24,873
reported for a one-turn session whose request processed 15,851), and it leaves the per-section lists empty.
NEXUS therefore labels a summary breakdown **estimated** and uses it for proportions. `full` asks the runtime
to count each category, which makes token-count requests; their effect on plan limits is not documented, so
it is opt-in. The per-request figures in `cache_events` are observed and are the authority for totals.

Not measured in 0.7.1: SECURITY_POLICY as a separate figure (NEXUS's safety text is part of the role prompt
and counted there) and THINKING_HISTORY (the runtime reports thinking tokens inside output per session; they
are carried on the usage figures and not split per request).

Where it is shown: Usage, Context (composition across sessions, whole percentages); Agents, an agent,
Context (that session's components with their basis and detail).

## Techniques and defaults

`TokenSettings` has one switch per technique: `auto`, `on`, `off`. `auto` means the release default
(`AUTO_DEFAULTS` in `src/shared/token.ts`).

| Technique | What | Lossless | Release default |
| --- | --- | --- | --- |
| Per-request and per-session accounting | measurement | yes | always on |
| Canonical prefix (registry, auditor, hash tests) | keeps NEXUS's prefix text stable | yes | always on |
| Failures first in check output | adds the failures before the tail of a long output | shows a superset | on |
| Context Graph in packs | map, related nodes, tools | adds context; removes entries known not current | see the release report |
| Stable system prefix | `excludeDynamicSections` | information yes, position no | off: measured, no benefit |
| NEXUS tools upfront | `alwaysLoad` | definitions only | off: measured, no effect |
| Rotation by context pressure | keep a small session at its turn limit | no | off: not evaluated with real runs |

## Check output

`token/filter.ts`. 0.7.0 showed the last 3,000 characters of each check's output. A failure before the tail
was invisible.

- `superset` (default): everything the tail showed, plus the failure lines before the tail with three lines
  of context, plus summary lines, with `[... N lines omitted; the full output is stored ...]` markers. The
  section budget grows by exactly what was added, so no check that fitted before is pushed out.
- `tail`: the 0.7.0 rendering (setting `off`).
- `compact` (setting `on`): also shortens passing runs to their summary lines and a short tail. A run that
  exits 0 but prints a failure line is not compacted.

A property test checks on random outputs that `superset` never drops a failure line that `tail` kept. Raw
output stays stored (check results, tool events) and is not changed by any of this.

## Tool planning

`planTools`. The runtime defers MCP tool definitions behind tool search by default. NEXUS has 5 tools (9 with
the graph tools, 10 with graph changes). The planner can mark the NEXUS server `alwaysLoad` when there are
10 or fewer; measured on the real runtime this did not change the size of a request, so the default leaves
the runtime's behaviour alone. External MCP servers a project configures are always left to the runtime.

Programmatic tool calling is not available through the Agent SDK. The equivalent NEXUS can offer is an
aggregating tool: `context_open` returns a node with its children, relations and sources in one bounded
answer instead of five calls whose intermediate results would all enter the context.

Parallel tool use is the runtime's default and nothing in NEXUS disables it.

## Session efficiency

`decideSessionAction`. Inputs: turns, the turn limit, the context size and window the runtime reported, the
share that is tool results, compactions so far, whether a handoff can carry the work, risk. Actions: KEEP,
CLEAR_STALE_TOOL_RESULTS, COMPACT, HANDOFF_AND_ROTATE.

- Default (pressure rotation off): exactly 0.7.0. A session that reaches `sessionRotationTurns` is rotated
  with a structured handoff.
- Pressure rotation on: a session that reaches its turn limit with a small context is continued (rotating
  would discard a warm cache to drop little); one whose context is above 85% is rotated; with no figure from
  the runtime the turn rule applies.

CLEAR_STALE_TOOL_RESULTS and COMPACT are reported, not executed: the runtime clears old tool results and
compacts by itself. NEXUS's part is that every result is stored outside the model's context, so nothing the
runtime clears is lost. See `CONTEXT_LIFECYCLE.md`.

## The decision log

Every context decision is a `TokenOptimizationDecision`: STABLE_PREFIX, DEFER_TOOLS, LOAD_TOOLS_UPFRONT,
RETRIEVE_GRAPH_BRANCH, EXPAND_GRAPH_NODE, WIDEN_RETRIEVAL, FILTER_OUTPUT, CLEAR_TOOL_RESULTS, COMPACT,
ROTATE_SESSION, PROGRAMMATIC_TOOLS, KEEP_FULL_CONTEXT, with a reason, a per-decision token effect and its
basis. KEEP_FULL_CONTEXT is a decision like any other: it is recorded when quality demanded the full context.

Token effects are per decision and are never added up: decisions overlap, and a sum would double count.

## The quality gate

`evaluateGate(baseline, optimized, config)` (`token/quality-gate.ts`). Trials are paired by case; a case
passes when its hidden evaluation and acceptance pass with no critical finding.

| Verdict | Condition | May become default |
| --- | --- | --- |
| INSUFFICIENT_EVIDENCE | fewer than 8 paired cases (16 for high or critical risk) | no |
| INFERIOR | critical findings rose; or the pass rate may be lower by more than the margin (5 points; 0 for high risk); or repairs rose; or, for high risk, any case regressed | no |
| NON_INFERIOR | none of the above | yes |
| IMPROVED | pass rate higher and the lower bound above zero | yes |

The gate also reports the relative change in input tokens, output tokens, turns and wall time, so a token
saving is seen next to its quality result and never instead of it. Retrieval is scored separately
(`scoreRetrieval`): recall of required nodes, precision, and nodes presented as current that are not.

## Provider capabilities

`capabilitiesOf(provider)`. Claude: automatic caching, per-request usage, context breakdown, tool search,
compaction events, thinking tokens, NEXUS tools, resume. Codex: cached-input figure after a turn, resume;
nothing else. A session's options are provider-neutral (`SessionContextOptions`); each runtime applies what
it supports, and the prefix recorded for a Codex session carries no Claude option.

## Quota

NEXUS does not convert tokens into a share of a plan. The plan windows are read from the runtime
(`USAGE_INTELLIGENCE.md`). Approaching a limit, NEXUS does not lower intelligence: it finishes the coherent
active work, pauses dispatch and resumes after the reset (`QUOTA_RECOVERY.md`). How uncached tokens, cache
reads and turns relate to the change of a plan window is not established in this release: the window
percentage moves in whole points and was not sampled per mission.
