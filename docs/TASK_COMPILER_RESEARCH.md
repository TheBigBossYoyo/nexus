# Task compiler research

2026-10-07. [DSPy](https://dspy.ai/) separates typed task signatures, composition and optimization against explicit metrics. [MIPRO research](https://arxiv.org/abs/2406.11695) evaluates multi-stage instruction changes against downstream outcomes. Neither establishes that expanding every request improves engineering quality.

Adopt typed, bounded passes and held-out execution evaluation. Do not add DSPy as a runtime dependency or optimize wording for its own sake. Compare compilation plus execution usage, final hidden evaluation, repairs, findings and human decisions. Fake tests establish protocol invariants only.

Preserve the raw request byte-for-byte. Only deterministic extraction may create USER_EXPLICIT fields; models return additions with lower authority. Model output is data and must be validated before use. Context nodes supply evidence references, never policy. Proposed scope expansion and consequential ambiguity stop execution for a user decision. User edits form a new revision with confirmation provenance.

EXACT bypasses model expansion, not security. LIGHT is deterministic. STANDARD, TECHNICAL and COUNCIL require capable configured providers; missing capacity must not silently turn them into LIGHT. AUTO depth is explainable policy, provisionally heuristic until Arena evidence exists. Cache identity includes raw intent, scope, policy/compiler versions, provider strategy and context versions; reject stale specs before dispatch.
