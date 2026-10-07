# NEXUS 0.7.0 token baseline

Measured on 2026-10-07 from `main` at `v0.7.0`, before any 0.7.1 change. Reproduce with
`node scripts/token-baseline.mjs` (add `--json` for the full report). Nothing here cost Claude usage: the
observed figures come from the evidence files of the real acceptance runs already stored under
`docs/acceptance`, and the static figures are measured on the prompts NEXUS builds.

Labels used in this document:

- **OBSERVED**: reported by the Claude runtime during a real run (`modelUsage` of the SDK result message).
- **ESTIMATED**: characters / 4. NEXUS 0.7.0 has no tokenizer and counts context packs in characters.
- **NOT MEASURED**: 0.7.0 does not record it. Each of these is a gap 0.7.1 closes.

## 1. What 0.7.0 records, and what it cannot answer

| Quantity | 0.7.0 | Source |
| --- | --- | --- |
| Uncached input, output, cache read, cache creation, per agent | OBSERVED | `usage_snapshots`, `usage_events` |
| Model turns, tool calls, sessions, rotations | OBSERVED | `agents.metrics`, `agent_sessions` |
| Context pack size | characters only | `context_packs.total_chars` |
| System prompt tokens, tool-definition tokens | NOT MEASURED | the SDK's `getContextUsage()` is never called |
| Conversation-history and tool-result tokens | NOT MEASURED | same |
| Thinking tokens | NOT MEASURED | `ModelUsage.thinkingTokens` exists in SDK 0.3.288 and is dropped by `translate.ts` |
| Per-request cache read / write | NOT MEASURED | only the cumulative figure of the result message is read |
| Compactions | a status string | `compact_boundary` carries `pre_tokens` / `post_tokens`; both are dropped |
| Why a session's prefix was re-written | NOT MEASURED | no prefix hash exists |

"Why did this request contain N tokens?" cannot be answered in 0.7.0.

## 2. Observed usage of real runs

All runs used the Claude subscription subscription through the Agent SDK (`claude-opus-5-5` and `claude-sonnet-5-5`),
on small acceptance repositories. "Processed input" is uncached + cache read + cache creation.

| Workload | Runs | Sessions | Turns | Uncached in | Cache read | Cache write | Output | Read share | Write share | Cache write / session | Processed / turn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BUILD mission (ADAPTIVE resolved to BUILD) | 2 | 10 | 66 | 24,690 | 389,822 | 151,570 | 19,939 | 68.9% | 26.8% | 15,157 | 8,577 |
| SPECULATIVE mission | 1 | 4 | 26 | 9,191 | 137,694 | 51,950 | 10,084 | 69.3% | 26.1% | 12,988 | 7,648 |
| Provider mission (Claude side) | 2 | 8 | 52 | 18,484 | 337,122 | 91,700 | 17,347 | 75.4% | 20.5% | 11,463 | 8,602 |
| Workspace mission | 2 | 20 | 116 | 49,278 | 854,503 | 146,490 | 30,253 | 81.4% | 13.9% | 7,325 | 9,054 |
| Program (3 missions, 7 ask runs) | 1 | 9 | 52 | 23,979 | 397,538 | 45,454 | 11,969 | 85.1% | 9.7% | 5,050 | 8,980 |
| Arena campaigns (SINGLE and BUILD trials) | 2 | 53 | 453 | 176,911 | 3,577,275 | 584,551 | 219,537 | 82.4% | 13.5% | 11,029 | 9,578 |

Median successful BUILD mission (two runs, nearly identical): **5 sessions, 33 turns, 12.3k uncached input,
195k cache read, 75.8k cache write, 10.0k output**.

Per role, BUILD mission of 2026-10-04 21:14 (OBSERVED):

| Role | Sessions | Turns | Uncached in | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Planner | 1 | 9 | 1,231 | 43,489 | 16,045 | 3,053 |
| Worker | 1 | 6 | 2,276 | 50,484 | 18,048 | 1,414 |
| Reviewer | 1 | 3 | 2,876 | 15,966 | 16,954 | 730 |
| Verifier | 2 | 14 | 5,802 | 75,588 | 24,342 | 4,532 |

Arena, by strategy (campaign of 2026-10-04 19:23): SINGLE 9 sessions / 89 turns / 750,679 read / 109,813 write;
BUILD 19 sessions / 167 turns / 1,250,875 read / 233,011 write. No CONSENSUS or SWARM run recorded cache
fields; those two strategies are **NOT MEASURED** in this baseline.

Session rotations: six `session-rotation` evidence files exist; they predate the cache fields, so the token
cost of a rotation is **NOT MEASURED**. Compactions: none observed (sessions are 3 to 16 turns).

## 3. What the numbers say

1. **Sessions are short and the prefix dominates.** A session runs 3 to 16 turns and processes about 8.6k to
   9.6k input tokens per turn. Nearly all of that is the Claude Code system prompt, the tool definitions and
   the first message, re-read from cache on every turn.
2. **Every session pays to write its own prefix.** Cache writes are 10% to 27% of processed input. The
   reviewer session is the clearest case: 3 turns, 16,954 tokens written, 15,966 read. A three-turn session
   that writes more than it reads did not start from a warm cache.
3. **Cross-session reuse happens sometimes, not reliably.** Cache write per session ranges from 4,981
   (SPECULATIVE reviewer) and 5,050 (Program) to 18,048 (BUILD worker). The cheap sessions started from a
   prefix an earlier session had written; the expensive ones did not. The difference, roughly 8k to 12k
   tokens per session, is the size of the opportunity. **INFERRED** from aggregate figures: 0.7.0 records no
   per-request cache data, so the cause cannot be read from the baseline. Section 5 lists the three
   candidate causes found in the code.
4. **Output is small.** 9% to 13% of uncached-plus-output volume per turn; about 300 output tokens per turn.
5. **The context pack is not where the tokens are.** See section 4: the pack is a few thousand characters
   against a per-turn prefix of several thousand tokens. Making the pack smaller cannot move the totals;
   making agents need fewer turns, and making sessions share a prefix, can.

## 4. Static prompt components

| Component | Size | Label |
| --- | --- | --- |
| Role prompt appended to the system prompt | 2,138 to 4,239 chars, ~535 to ~1,060 tokens by role | ESTIMATED |
| Text identical in every role prompt (principles, NEXUS tools, environment) | 1,671 chars, ~418 tokens, 3 paragraphs | ESTIMATED |
| Position of that shared text | **after** the role-specific text (paragraph 3 of the worker prompt) | measured |
| NEXUS tool definitions (5 tools) | NOT MEASURED in 0.7.0 | |
| Claude Code preset system prompt and built-in tool definitions | NOT MEASURED in 0.7.0 | |
| Context pack section budgets | task 8,000, criteria 4,000, decisions 6,000, dependencies 8,000, facts 5,000, memory 6,000, messages 6,000, findings 12,000, failure 10,000, handoff 6,000 chars | `SECTION_LIMITS` |
| Repository facts per pack | at most 8 | `FACT_LIMIT` |
| Project memory per pack | at most `maxEntriesPerContext` (settings) | |
| Program memory per mission | at most 6 | `MEMORY_PER_MISSION` |
| Check output per command in a prompt | last 3,000 chars | `SECTION_LIMITS.checkItem` |

## 5. Duplication and waste found in the code

| # | Finding | Evidence | Kind |
| --- | --- | --- | --- |
| D1 | The system prompt contains each agent's working directory and git status. Every task has its own worktree, so no two agents share a system prompt. | `claude-sdk-runtime.ts:617` uses the `claude_code` preset without `excludeDynamicSections`; `cwd: spec.cwd` | cache prefix |
| D2 | The shared 418 tokens of every role prompt come last, after the role-specific text, so they are never a common prefix between roles. | `prompts.ts:148` | cache prefix |
| D3 | NEXUS's five MCP tools are deferrable by the SDK's tool search, which is on by default. A session that needs `send_message` may pay a search round trip first. | SDK 0.3.288 `alwaysLoad`; `createNexusMcpServer` does not set it | turns |
| D4 | The tool list is described twice: in the role prompt (`NEXUS_TOOLS`) and in the tool definitions themselves. | `prompts.ts:16`, `claude-sdk-runtime.ts:371` | duplicate instructions |
| D5 | Check output is cut to its last 3,000 characters. A failure that is not in the tail is invisible to the debugger, and a passing run spends the same 3,000 characters on passing lines. | `render.ts:86` | lossy and wasteful |
| D6 | The same repository fact (for example the test command) is rendered into the pack of every task, every repair and every review of a run, and again in "Repository state". | `context-engine.ts:178`, `context-builder.ts:138` | repeated knowledge |
| D7 | Three memory stores (`memory`, `program_memory`, `workspace_memory`) and `repository_facts` use four different relevance functions, three stop-word lists and three tokenizers. A fact known to one store is invisible to the others. | `context-engine.ts:26`, `program/memory.ts:19`, `intelligence/select.ts:24`, `repositories/memory.ts` | duplicated mechanism |
| D8 | A superseded Program memory entry and a stale repository fact are filtered by separate code paths; Project memory has no supersession at all. | `program/memory.ts:66`, `context-engine.ts:179` | inconsistent truth |
| D9 | Thinking tokens, per-request usage and compaction sizes are reported by the runtime and discarded. | `translate.ts:62`, `translate.ts:137` | lost measurement |

How much project knowledge is retransmitted (ESTIMATED, from `SECTION_LIMITS` and the BUILD run above): a
five-session mission renders the project name, branch, base commit and four check commands five times, and up
to eight facts five times. At the section budget this is at most ~1,750 tokens per session and ~8,750 per
mission, against ~283k processed. It is real duplication and it is 3% of the mission, not the main cost.

## 6. What 0.7.1 must be measured against

| Metric | Baseline (median BUILD mission) |
| --- | --- |
| Sessions | 5 |
| Turns | 33 |
| Uncached input | 12.3k |
| Cache read | 195k |
| Cache write | 75.8k (15.2k per session) |
| Output | 10.0k |
| Cache read share of processed input | 68.9% |
| Hidden evaluation (Arena, 3 cases x SINGLE and BUILD) | campaign of 19:23: 6 of 6 passed; campaign of 19:01: 4 of 6 passed (two BUILD trials ended `blocked`) |

The usage-window change of a mission (percent of the five-hour or weekly window) is **NOT MEASURED** per
mission in the evidence: the window percentage was read before and after whole campaigns only.
