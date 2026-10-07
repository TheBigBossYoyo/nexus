# Prompt caching

What NEXUS can and cannot do about the prompt cache, what was measured on the real runtime, and how cache
behaviour is recorded and explained. Background: `TOKEN_OPTIMIZATION_RESEARCH.md`.

## Who controls what

NEXUS runs agents through the Claude Agent SDK on the user's subscription. The runtime (Claude Code)
assembles each request: it places the cache breakpoints, picks the TTL and renders `tools`, then `system`,
then `messages`. A host cannot set `cache_control` or a TTL per request. NEXUS never calls the Messages API
to get that control: it would be billed separately from the subscription.

What NEXUS controls: the role text appended to the system prompt, which built-in tools a role sees, the
NEXUS tools, the model, and the first user message.

## What was measured

`pnpm smoke:cache` runs seven one-turn sessions on the real runtime and records the first request of each
(evidence: `docs/acceptance/cache-acceptance-2026-10-07T*.json`; model `haiku`; every figure is
runtime-reported).

| Session | Change from the one before | Read | Written | Result |
| --- | --- | ---: | ---: | --- |
| Worker, directory A | first | 0 | 16,008 | prefix written |
| Worker, directory B | another working directory | 14,994 | 1,015 | prefix read |
| Worker, A, stable-prefix option on | option turned on | 13,231 | 2,609 | read, small part rewritten |
| Worker, B, option on | another working directory | 14,826 | 1,015 | prefix read |
| Worker, B, option on, another prompt | only the prompt | 14,826 | 1,016 | prefix read |
| Reviewer, A, option on | another role (its tools and role text) | 0 | 14,458 | nothing shared |
| Worker, B, option on, NEXUS tools upfront | tool loading option | 15,841 | 0 | read; same request size |

What this establishes:

1. **The working directory is not part of the cached prefix.** Two sessions of one role in different
   worktrees share the prefix with no option set. The assumption in the first draft of the baseline (that
   every worktree writes its own prefix) was wrong.
2. **The stable-prefix option (`excludeDynamicSections`) adds nothing here.** Same read and write with and
   without it. It stays off: it has a documented cost (the working directory steers the model slightly less
   from a user message) and no measured benefit.
3. **A different role shares nothing**, not even the runtime's own system prompt, because tools render first
   and each role has its own tool list. This is why a mission's cache writes are about 15,000 tokens per
   distinct role: planner, worker, reviewer and verifier each write once.
4. **A changed prompt reuses the prefix.** The dynamic suffix does not disturb it.
5. **Loading the NEXUS tools upfront changed nothing** in the size of the request. It stays off.

All four checks of the acceptance are met: first request writes, a later one reads, a changed suffix still
reads, a changed stable part (role) writes again.

## What follows for NEXUS

- The prefix NEXUS writes is canonical already: role prompts are constants with no timestamp, id or
  path, and a test keeps them so (`tests/unit/token/token.test.ts`, "role prompts are a canonical prefix").
- Within a role, reuse works. The cost that remains is one cold start per role per cache lifetime.
- **Not done, and why:** giving every role the same tool list (with the policy gate refusing what a role may
  not use) would let roles share the 17,800 tokens of built-in tool definitions. It would also show
  read-only roles tools they must not use, which changes the security posture ("a tool a role may not use
  does not exist for it") and the prompt. It needs a security review and a quality comparison first. It is
  recorded as the largest remaining cache lever, not implemented.
- Reordering the role prompt so that shared text comes first is not done: the shared text is about 418
  tokens, below the minimum cacheable prefix of the current models, and roles differ in tools before that
  anyway.

## TTL

Left to the runtime: one hour on a subscription within its limits, five minutes when drawing on usage
credits. NEXUS does not force `1h`. The runtime does not report the TTL in effect on an ordinary turn, so
NEXUS records the reuse distance (time since the same prefix was last used) with each first request.

## What is recorded

For every model request (`cache_events`): the session, the request index, uncached input, cache read, cache
write, output, the model, the role and the provider. One response delivered as several assistant messages is
counted once (by API message id).

For the first request of a session, also:

- `prefixHash`: a hash of what decides whether the prefix can be shared: provider, model, effort, role text,
  tool names (sorted) and runtime options. The working directory is not in it.
- `result`: `read`, `write`, `partial` or `none`.
- `expectedWarm`: the same prefix was used by another session within the assumed lifetime.
- `cause`, when the prefix was written although a read was possible.

`prompt_prefixes` keeps each prefix with its parts, how often it was used and what the cache did last.

## Diagnosis

The API's cache diagnostics (`diagnostics.previous_message_id`) are not available through the Agent SDK. So
the cause of a miss is NEXUS's own inference and is always labelled `local_inference`; the token figures are
the runtime's.

| Cause | When |
| --- | --- |
| FIRST_USE | No earlier session used this prefix or this role |
| TOOLS_CHANGED | The role's tool set differs from the last one it used |
| MODEL_CHANGED | The model differs (caches are per model) |
| EFFORT_CHANGED | The effort level differs |
| SYSTEM_CHANGED | The role text or a runtime option differs |
| EXPIRED | The same prefix was last used longer ago than the assumed lifetime |
| UNKNOWN | Same prefix, used recently, still written |
| DYNAMIC_PREFIX_CONTAMINATION | Per-session text is part of the prefix a provider caches. Not produced for the Claude runtime, which keeps it out by itself (measured above); kept for a provider that does not |

FIRST_USE is not a miss. The Usage page lists the others under "Prefixes written again when a read was
possible".

The prompt auditor (`token/auditor.ts`) checks any set of prompt blocks for: an identical paragraph in two
places, volatile text (timestamp, UUID, absolute path) in a block declared stable, a stable block after a
volatile one, passing-test spam, a file injected twice, and a tool schema loaded and never called. It
reports; it removes nothing, and it never treats merely similar text as duplicate.

## Where to look

- Usage, Cache: share read from cache, read / write / uncached totals, warm and cold session starts, by role
  and by model, and the misses with their likely cause.
- Agents, an agent, Context: that session's requests, what its first request did, and why.

## Providers

Codex sessions report cached input after a turn and nothing per request; NEXUS sends them no Claude option
and records what they report. See `PROVIDERS.md`.
