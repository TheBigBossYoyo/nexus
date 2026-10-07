# Director and OpenAI integration research

Checked 2026-10-07 against official documentation and the installed repository. Capability status is separate from implementation and acceptance status.

| Capability | Classification | Source / implication |
| --- | --- | --- |
| Local-app SIWC with optional plan use | OFFICIALLY_SUPPORTED | [Overview](https://developers.openai.com/siwc/token-sharing-open-source); eligibility still requires successful account authorization |
| Dynamic registration, stable host UUID, PKCE, state and nonce | OFFICIALLY_SUPPORTED | [Sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in); issued client ID belongs with validated issuer/subject; returning callback cannot replace it |
| Identity without plan use | OFFICIALLY_SUPPORTED | Granted `chatgpt.tokens.use.direct` scope, not an ID token alone, permits inference |
| Rotating refresh tokens | OFFICIALLY_SUPPORTED | [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference); use returned expiry, serialize refresh, atomically replace credentials |
| Direct streamed Responses | OFFICIALLY_SUPPORTED | [Inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference); public API only; completion requires terminal success |
| Model catalog | OFFICIALLY_SUPPORTED | Same account token; catalog visibility does not prove inference entitlement |
| Codex app-server with SIWC | OFFICIALLY_SUPPORTED | [Configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server); preserve existing CLI integration independently |
| ChatGPT conversation or memory access | NOT_AVAILABLE | SIWC grants neither |
| Council superiority | NOT_AVAILABLE | Requires a real controlled comparison; simulated protocol success proves mechanics only |

Request contract: `store:false`, `stream:true`, array input, instructions/developer content. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) prohibit several normal Responses options, including temperature, max_output_tokens and previous_response_id over HTTP. Build an allowlist request rather than forwarding arbitrary UI fields.

Design: separate advisory inference from worker execution. Directors receive bounded, scoped evidence and cannot execute host tools. Council preserves disagreement and unresolved evidence. Memo, challenge and synthesis are validated artifacts, not hidden reasoning. Security and release authority remain deterministic.

Installed baseline: Claude Agent SDK 0.3.288; Codex adapter supports read-only roles, no NEXUS tool bridge. No inference performed for this research. DPAPI storage is already available through the Electron runtime host; do not place credentials in renderer or SQLite.
