# Token optimization research (NEXUS 0.7.1)

Researched 2026-10-07 for the versions NEXUS actually ships: `@anthropic-ai/claude-agent-sdk` 0.3.288 (which
pins Claude Code 2.1.288) and `@anthropic-ai/sdk` ^0.131. Baseline numbers are in `V0_7_1_BASELINE.md`.

## Status labels

| Label | Meaning |
| --- | --- |
| PROVEN | Measured in NEXUS, by a test or a real run recorded in the release report. |
| DOCUMENTED | Stated by current official Anthropic documentation or by the installed SDK's type definitions. Not yet measured in NEXUS. |
| EXPERIMENTAL | Marked alpha, beta or "may change" by its source. |
| INFERRED | Reasoned from documentation and baseline figures. Not stated by a source and not measured. |
| NOT AVAILABLE | A Claude API feature that the installed Agent SDK gives a host no way to set. |

## Sources

| Id | Source |
| --- | --- |
| S1 | Installed type definitions, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (0.3.288) |
| S2 | Agent SDK, "Track cost and usage": code.claude.com/docs/en/agent-sdk/cost-tracking |
| S3 | Agent SDK, "Scale to many tools with tool search": code.claude.com/docs/en/agent-sdk/tool-search |
| S4 | Claude Code, "Manage costs effectively": code.claude.com/docs/en/costs |
| S5 | Claude API, prompt caching: platform.claude.com/docs/en/build-with-claude/prompt-caching |
| S6 | Claude API, context editing: platform.claude.com/docs/en/build-with-claude/context-editing |
| S7 | Claude API, memory tool: platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool |
| S8 | Claude API, compaction: platform.claude.com/docs/en/build-with-claude/compaction |
| S9 | Anthropic engineering, "Effective context engineering for AI agents" |
| S10 | Anthropic engineering, "Introducing advanced tool use" (tool search, programmatic tool calling) |
| S11 | Anthropic, "Introducing Contextual Retrieval" |
| S12 | Claude API, token counting: `POST /v1/messages/count_tokens` |

## The constraint that shapes everything

NEXUS does not call the Messages API. It starts Claude Code through the Agent SDK, on the user's
subscription. Claude Code assembles each request: it places the cache breakpoints, chooses the cache TTL,
runs tool search, clears old tool results and compacts. A host can set options, read what the runtime
reports, and decide what text it puts into the system prompt append and the user messages. It cannot set
`cache_control`, `context_management`, `defer_loading` or `diagnostics` on a request.

So the 0.7.1 architecture is: **shape what NEXUS controls so that the runtime's own caching and context
management work as well as they can, measure with what the runtime reports, and never route around the
subscription to reach an API feature.** Calling the Messages API directly to get explicit breakpoints would
be separately billed and is ruled out (specification section 36).

## Techniques

Each row: mechanism; expected token saving; quota effect; latency; quality; cache interaction; memory
interaction; security; SDK support; difficulty; lossless?; Arena needed?; recommendation.

### 1. Stable cross-agent system prefix (`excludeDynamicSections`)

- **Mechanism.** `systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true }`
  moves the working directory, memory path and git status out of the system prompt into the first user
  message, so the system prompt is byte-identical for every session with the same role text (S1).
- **Why it matters here.** Every NEXUS task runs in its own worktree, so in 0.7.0 no two agents have the
  same system prompt (baseline D1). Baseline sessions write 5k to 18k cache tokens each.
- **Expected saving.** Up to roughly 8k to 12k tokens per session moved from cache write to cache read for
  every session after the first with the same role and tool set inside the TTL. INFERRED.
- **Quota effect.** Unknown. Plan limits are not documented as following API prices; `/usage` does flag
  "cache misses" as a behaviour that raises plan usage (S4), which suggests reads count for less. INFERRED.
- **Latency.** Lower time to first token on a cache hit (S5).
- **Quality.** The SDK states the tradeoff: the moved context is "marginally less authoritative for steering
  the model" (S1). The information is not removed.
- **Cache.** This is a cache technique. **Memory.** None. **Security.** None: the security policy stays in
  the system prompt.
- **SDK support.** DOCUMENTED (S1). **Difficulty.** Low. **Lossless.** Information: yes. Position: changed.
- **Arena.** Yes for becoming the default without a setting; a real cache acceptance (request 1 writes,
  request 2 of another agent reads) is the proof it works.
- **Recommendation.** Implement behind `stablePrefix`. Default ON only if the real cache acceptance shows
  the cross-agent read and no quality regression is observed; otherwise ship OFF.

### 2. Role prompt ordering (shared text first)

- **Mechanism.** Put the text every role shares (principles, NEXUS tools, environment) before the
  role-specific text, so roles share a longer prefix.
- **Expected saving.** Small. The shared text is ~418 tokens, below the 512-token minimum cacheable prefix
  of the current Opus and Sonnet models by itself (S5), and roles also differ in their tool lists, which
  render before the system prompt. INFERRED: no measurable gain across roles.
- **Quality.** Reordering instructions is a prompt change, not a lossless one.
- **Recommendation.** **Do not do it.** The specification forbids reordering meaningful content for caching
  alone, and the expected gain is nil. Recorded so that the idea is not retried without evidence.

### 3. Prompt caching itself

- **Mechanism.** Prefix match over `tools`, then `system`, then `messages`; reads cost about 0.1x input
  (0.05x on Opus 5.5), writes 1.25x (5 minutes) or 2x (1 hour); a read refreshes the TTL (S5).
- **SDK support.** Automatic. "The Agent SDK automatically uses prompt caching... You do not need to
  configure caching yourself" (S2). Explicit breakpoints: NOT AVAILABLE.
- **Recommendation.** Nothing to enable. The work is keeping the prefix stable (1, 4) and measuring (5, 6).

### 4. Canonical, deterministic prompt text

- **Mechanism.** No timestamps, run ids, random ids or unordered maps in anything that can sit in a prefix;
  volatile facts go last.
- **State in 0.7.0.** The role prompts are constants. The first user message starts with the task, which
  differs per task anyway. No timestamp reaches the system prompt. So the prefix NEXUS writes is already
  canonical; the instability comes from the runtime's dynamic sections (1).
- **Recommendation.** Enforce with a registry and a test (prefix hash must not change with time, run id or
  object order), so a later change cannot break it silently. Lossless.

### 5. Cache TTL

- **Mechanism.** `promptCacheTtl` / `subagentPromptCacheTtl` settings or `ENABLE_PROMPT_CACHING_1H`.
  Unset means automatic: one hour on a subscription within its limits, five minutes once on usage credits
  (S1, S2).
- **Recommendation.** Leave unset. The automatic choice is already the long TTL for NEXUS's account mode,
  and forcing `1h` would keep the dearer writes when the account is drawing on credits. The runtime does not
  report the TTL in effect to a host on an ordinary turn, so NEXUS records reuse distance (time between two
  sessions with the same prefix hash) and whether the second one read or re-wrote. DOCUMENTED.

### 6. Cache diagnostics

- **Mechanism (API).** `diagnostics: { previous_message_id }` under the beta `cache-diagnosis-2026-04-07`
  explains a miss. NOT AVAILABLE through the Agent SDK.
- **What is available.** Per-request `cache_read_input_tokens` / `cache_creation_input_tokens` on every
  assistant message (S2), `prompt_cache_likely_expired` on the `SessionStart` hook of a resumed session
  (S1; `prompt_cache_warm` and `cache_ttl` exist only on the model-switch hooks, which NEXUS never
  triggers), and the `cache_miss` behaviour share in the usage report (S1, EXPERIMENTAL).
- **Recommendation.** Build local diagnostics: hash the prefix components NEXUS controls, record per-request
  cache figures, and when an expected-warm prefix is re-written, name the component whose hash changed. Label
  every such diagnosis LOCAL INFERENCE; label the token figures SERVER-REPORTED.

### 7. Request component accounting (`getContextUsage`)

- **Mechanism.** `query.getContextUsage()` returns the context window by category: system prompt sections,
  system tools, MCP tools (each with tokens and whether loaded), memory files, skills, and a message
  breakdown (tool call, tool result, assistant, user tokens; per tool name). `detail: 'full'` counts with
  the token-count API; `'summary'` answers from the last response and local estimates (S1).
- **Cost.** `'full'` makes token-count calls. Their effect on plan limits is not documented.
- **Recommendation.** Implement. Take one snapshot per session at its end with `'summary'` by default;
  `'full'` is a setting. This is the official answer to "why did this request contain N tokens"; NEXUS's own
  estimates fill in only what the runtime does not split (which part of the first message is graph context).

### 8. Tool search / deferred loading

- **Mechanism.** On by default in the Agent SDK. Deferrable definitions (every MCP tool not marked
  `alwaysLoad`, plus on-demand built-ins) are withheld; the model searches and up to five definitions are
  loaded, appended so the cache prefix survives. Each search is an extra round trip. "With fewer than ~10
  tools... loading everything upfront is typically faster" (S3). Measured elsewhere: 85% fewer definition
  tokens with a 77k-token catalogue, and better selection accuracy (S10).
- **NEXUS's situation.** The premise that NEXUS has a large tool surface is false for what agents see: a
  role-filtered list of built-ins plus 5 MCP tools (9 with the context tools 0.7.1 adds). Tool search is
  already active by default for them, which costs a round trip (baseline D3) for definitions that are small.
- **Recommendation.** A `ToolSetPlanner` that decides per session: below 10 tools and a small token total,
  mark the NEXUS server `alwaysLoad`; above that, leave deferral on. External MCP servers a project
  configures stay deferred (the runtime default). Default to the planner's choice only after the fake-runtime
  comparison and, quota permitting, one real comparison. DOCUMENTED; the saving in NEXUS is INFERRED.

### 9. Tool definition hygiene

- **Finding.** The five NEXUS tools are described twice: in the role prompt and in the definitions (D4).
- **Recommendation.** Keep both for now. The role-prompt list tells an agent *when* to use a tool; the
  definition says *how*. Removing either is a prompt change that needs evidence. Measure their token cost
  (7) and leave the decision to the quality gate. Not lossless.

### 10. Programmatic tool calling

- **Mechanism (API).** Claude writes code in the code-execution container that calls tools; intermediate
  results stay out of context. 37% fewer tokens on research tasks (S10). Not compatible with MCP tools.
- **SDK support.** NOT AVAILABLE through the Agent SDK for a host's tools.
- **Equivalent that is available.** Do the deterministic aggregation inside the tool. A graph tool that
  returns "the module, its tests, its decisions and its contracts" in one bounded call replaces five calls
  whose intermediate results would all have entered context.
- **Recommendation.** Design the context tools as aggregating, bounded tools. Lossless (raw records remain
  retrievable by id).

### 11. Parallel tool use

- **Mechanism.** One assistant message may hold several tool calls; the runtime executes read-only ones
  concurrently. Fewer turns means fewer re-reads of the whole history (S4, S9).
- **SDK support.** On by default; nothing in NEXUS disables it.
- **Recommendation.** Nothing to change in the runtime. One sentence in the shared principles would be a
  prompt change; left to the quality gate. Record tool calls per turn so the behaviour is visible.

### 12. Context editing (tool-result clearing)

- **Mechanism (API).** `clear_tool_uses_20250919` replaces old tool results with a placeholder past a
  threshold; clearing invalidates the cache from that point, hence `clear_at_least` (S6).
- **SDK support.** NOT AVAILABLE as a host setting. Claude Code does its own tool-result clearing and
  reports it as an "expected rebuild" (S4).
- **Recommendation.** Do not build a second mechanism. NEXUS's part is durability: every tool event and
  every check output is already persisted outside the model's context, so nothing the runtime clears is
  lost. Classify results (PINNED, ACTIVE, RETRIEVABLE, STALE) for NEXUS's own prompts and for the UI.

### 13. Compaction

- **Mechanism.** Claude Code summarises history near the auto-compact window; the SDK emits
  `compact_boundary` with `pre_tokens` and `post_tokens`, and `PreCompact` / `PostCompact` hooks (S1, S8).
  `autoCompactWindow` is a setting.
- **Finding.** No compaction occurred in any baseline run: sessions are short, and NEXUS rotates sessions by
  turn count before the window fills.
- **Recommendation.** Use the official mechanism; do not write a summariser. Record every compaction with
  its sizes. Before a compaction nothing needs to be saved by the model, because the requirements, criteria,
  decisions, commits and review findings live in the NEXUS database and are re-sent by the next prompt
  NEXUS builds. Background compaction: NOT AVAILABLE as a host control.

### 14. Session rotation and handoff

- **Mechanism.** NEXUS ends a session at a turn threshold, asks for a structured handoff and starts a fresh
  session with only the handoff and the task.
- **Cost.** A rotation throws away a warm conversation cache and pays for a new prefix write plus the
  handoff request. With processed input of ~9k per turn, a rotation is only worth it when the history it
  drops is larger than the prefix it re-writes. INFERRED from the baseline.
- **Recommendation.** Replace the fixed turn threshold with a controller that looks at context pressure
  (reported by the runtime), not turn count alone. Keep the 0.7.0 threshold as the fallback when the runtime
  reports no context figure. Rotation fidelity is tested with the fake runtime; a real comparison is
  NOT VERIFIED unless quota allows.

### 15. Thinking blocks

- **Mechanism.** On Opus 5.5 and Sonnet 5.5 thinking cannot be disabled and thinking blocks are bound to
  the conversation; editing earlier turns invalidates them (current model documentation). The runtime keeps
  them; the SDK reports `thinkingTokens` inside `outputTokens` (S1).
- **Recommendation.** Never touch them. Record `thinkingTokens`. Effort is not lowered for tokens.

### 16. Token counting

- **Mechanism.** `count_tokens` is exact and model-specific (S12). It needs an API credential; NEXUS runs
  on the subscription and strips API keys from agents.
- **Recommendation.** Do not call it. Use the runtime's figures (exact) and a character estimate for text
  NEXUS has not sent yet, always labelled ESTIMATED. NOT AVAILABLE on the subscription path.

### 17. Output filtering for checks and logs

- **Mechanism.** Give the model the status, the counts and the failures; keep the raw log as an artifact
  (S4 shows the same idea as a hook).
- **Finding.** 0.7.0 keeps the last 3,000 characters of each check output (D5): a failure outside the tail
  is hidden, which is a quality defect, not only waste.
- **Recommendation.** Implement a failure-first filter for NEXUS-run checks. It must show more of what
  matters than the tail cut does. Default ON: it is tested to never drop a failure line the tail cut kept,
  and the raw output stays retrievable.

### 18. Just-in-time context and sub-agent summaries

- **Mechanism.** Keep identifiers in context and load detail with tools; pass condensed results between
  agents (1,000 to 2,000 tokens) instead of transcripts (S9).
- **State in 0.7.0.** Already the design: reviewers get the diff and criteria, verifiers get TaskEvidence,
  dependents get result summaries. No transcript is passed between agents.
- **Recommendation.** Keep, and add tests that pin it (reviewer and verifier prompts contain no agent
  narration). The Context Graph extends the same idea to project knowledge.

### 19. Task budgets

- **Mechanism.** `taskBudget: { total }` tells the model its remaining token budget (S1, alpha).
- **Recommendation.** Not used. A budget the model paces itself against can shorten work; that is a
  capability tradeoff. EXPERIMENTAL.

### 20. Memory tool

- **Mechanism (API).** `memory_20250818`: a client-side tool with `view`, `create`, `str_replace`,
  `insert`, `delete`, `rename` under `/memories`; the API adds a "view your memory directory first"
  instruction to the system prompt (S7).
- **SDK support.** NOT AVAILABLE: the Agent SDK does not let a host add Anthropic-defined API tools. Claude
  Code has its own file-based auto-memory, which NEXUS disables (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) so
  that agents in throwaway worktrees do not write unreviewed memory.
- **Recommendation.** Expose the same operations as NEXUS MCP tools backed by the Context Graph, with the
  write policy NEXUS already has (agents propose; evidence required; instruction-shaped text refused). See
  `CONTEXT_GRAPH_RESEARCH.md`.

## What the research changes in the specification

| Specification assumption | Finding | Consequence |
| --- | --- | --- |
| NEXUS can place cache breakpoints and choose TTLs | The runtime does both; a host cannot | Work on prefix stability and measurement instead |
| NEXUS has a large tool surface | Agents see ~9 MCP tools | Tool search is evaluated as "when to turn deferral off", not on |
| Context packs are a large cost | A pack is a few thousand characters; the per-turn prefix dominates | The graph is judged on recall and on turns saved, not on pack size |
| A custom compactor or context editor may be needed | The runtime has both; no baseline session ever compacted | Record and gate; build neither |
| Token counting preflight | Needs an API key | Runtime figures plus labelled estimates |
| Programmatic tool calling | Not available | Aggregating tools |

## Recommended defaults for 0.7.1 (to be confirmed by measurement)

| Technique | Lossless | Default |
| --- | --- | --- |
| Per-request usage and cache accounting | yes (measurement) | ON |
| Context usage snapshot (`summary`) | yes (measurement) | ON |
| Thinking-token and compaction recording | yes (measurement) | ON |
| Canonical prompt registry and auditor | yes | ON |
| Failure-first check output | shows a superset of the failures | ON |
| Stable prefix (`excludeDynamicSections`) | information yes, position no | decided by the real cache acceptance |
| NEXUS tools always loaded when the set is small | definitions only | decided by comparison |
| Context Graph retrieval in packs | no | decided by the retrieval benchmark |
| Pressure-based rotation | no | OFF unless evidence |
| Model, effort, reviewer or agent-count reductions | no | never for tokens |
