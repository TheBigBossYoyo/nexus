# Multi-provider usage research

Checked 2026-10-07. [OpenAI account/session documentation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) states that Plus's five-hour allowance is shared across participating apps; Pro does not have that five-hour limit. App weekly caps are restrictions on existing capacity, not reservations or additional capacity. These are OFFICIALLY_SUPPORTED descriptions, not measured NEXUS account facts.

[Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) distinguishes plan limit, usage-service failure, entitlement, route, unsupported capability and authentication failures. A plan-limit code alone does not identify an account-wide limit or reset time. Preserve credentials on transient failures. Generic 429 means throttle unless a quota code establishes otherwise.

Exact OpenAI remaining-plan telemetry through direct SIWC: NOT_AVAILABLE in the inspected contract. Local request tokens: OBSERVED, never an account percentage. Existing Codex CLI adapter exposes turn usage, not plan windows. Shared identity between separately logged-in Codex and SIWC: UNKNOWN until verified; do not merge their pools merely because both are OpenAI.

Claude: installed `sdk.d.ts` exposes `supportedModels`, `rate_limit_event`, and an explicitly EXPERIMENTAL usage-report method. Existing NEXUS evidence on 2026-10-04 observed five-hour and weekly percentages/reset times. Keep that optional path and its unknown/stale semantics. No new Claude calls made. See `USAGE_INTELLIGENCE.md` for exact SDK fields and inherited evidence.

Policy design: capability and role-specific quality evidence precede capacity. Reserve is a local scheduling policy, not a provider quota. A shared pool blocks every verified consumer on an account-wide quota signal; an app cap blocks only its app. Unknown reset schedules bounded probes, never a fictional reset. Provider recovery makes work eligible at a coherent boundary; it does not interrupt a healthy session. Paid continuation remains off.
