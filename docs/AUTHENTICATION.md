# Authentication

## What NEXUS does

NEXUS does not store, read, or manage Claude credentials. It never reads the credential store,
browser cookies, or OAuth tokens, and it implements no login flow of its own.

Every agent session is a `claude.exe` process started by the official
`@anthropic-ai/claude-agent-sdk`. That runtime authenticates itself with whatever credentials the
official Claude Code runtime already has on this machine.

To log in, run the official flow in a terminal:

```
claude auth login
```

## How status is detected

The Authentication screen asks the runtime, not the filesystem. NEXUS starts an SDK session in
streaming-input mode without sending a prompt (no model usage), reads the SDK's initialization
result (`account`: subscription type, token source, API-key source, API provider), then closes it.

States shown: authenticated, authentication required, runtime unavailable, SDK error. Mode shown:
subscription, API key, or third-party provider.

## Subscription Mode and `ANTHROPIC_API_KEY`

If `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is present in the environment NEXUS was
launched from, the Authentication screen warns:

> ANTHROPIC_API_KEY is present and may cause Claude usage to be billed through the API rather than
> your Claude subscription.

The SDK's `env` option replaces the child process environment. When Subscription Mode is on
(Settings → Claude, default on), NEXUS passes each agent a copy of its environment with those
variables removed. Your machine-level and user-level environment variables are never modified.
With Subscription Mode off, the variables are passed through and the runtime decides which
credential to use.

## What is not promised

- Subscription usage is finite and governed by Anthropic. NEXUS surfaces rate-limit events from the
  SDK and pauses the run; it cannot raise limits.
- Anthropic's Agent SDK documentation states: "Unless previously approved, Anthropic does not allow
  third party developers to offer claude.ai login or rate limits for their products, including
  agents built on the Claude Agent SDK." NEXUS is a personal, local tool that offers no login of its
  own; it runs the Claude runtime you installed and authenticated yourself. Whether the runtime
  accepts a subscription login when driven through the SDK is decided by Anthropic and may change.
  If it stops being accepted, the supported path is an API key with Subscription Mode turned off.
  If you distribute NEXUS to other people, API-key authentication is the documented path.
- NEXUS does not claim "free" or "unlimited" usage of any kind.
