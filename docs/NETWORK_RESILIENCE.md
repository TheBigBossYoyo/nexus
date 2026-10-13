# Network resilience for unattended work

A network interruption is a wait, not a mission failure. While the network is down, work that needs it waits and work that does not goes on; when the network is back, the work resumes by itself. This document says what the module does, what it never does, and what is not yet proven on a real network.

Code: `src/main/modules/connectivity/`, types in `src/shared/connectivity.ts`, the Wi-Fi helper in `native/nexus-wlan/` (built by `scripts/build-wlan.mjs` to `out/native/nexus-wlan.exe`).

## The states

Exactly one at a time, decided by `classifyConnectivity` from the probes (a link, then names, then the Internet, then the provider, then the account's capacity). A layer is blamed only when everything below it answered.

| State | Evidence it rests on |
| --- | --- |
| `ONLINE` | A link, and at least one of two independent endpoints answers; no provider is down; no quota wait. A wired link with Internet is ONLINE with Wi-Fi off. |
| `WLAN_DISCONNECTED` | No Wi-Fi interface is associated, no wired link with an address, and nothing answers. |
| `WLAN_ASSOCIATED_NO_INTERNET` | A link exists, name lookup fails and no probed address answers. |
| `DNS_FAILURE` | Name lookup fails while a TLS connection to a literal address succeeds. |
| `INTERNET_UNREACHABLE` | Names resolve, but neither endpoints nor addresses can be connected to. |
| `PROVIDER_UNREACHABLE` | The Internet answers, every probed provider host does not. |
| `PROVIDER_QUOTA_WAIT` | The provider answers and the usage service reports the account limited. Not a network outage. |
| `RESEARCH_ONLY_UNAVAILABLE` | The provider answers but the general Internet endpoints do not (for example a network that lets only the provider through). |

A probe is a name lookup or a TLS handshake with certificate verification (so a captive portal is not "the Internet"). Nothing is sent but the handshake; no credential is used.

## What continues offline, what waits

`workAllowed(state)` in the shared types:

| | LOCAL | MODEL | RESEARCH | DEPENDENCY_INSTALL |
| --- | --- | --- | --- | --- |
| ONLINE | yes | yes | yes | yes |
| WLAN_DISCONNECTED, WLAN_ASSOCIATED_NO_INTERNET, DNS_FAILURE, INTERNET_UNREACHABLE | yes | wait | wait | wait |
| PROVIDER_UNREACHABLE, PROVIDER_QUOTA_WAIT | yes | wait | yes | yes |
| RESEARCH_ONLY_UNAVAILABLE | yes | yes | wait | wait |

LOCAL work is builds, tests, lint, local git, app launch and local browser verification. `describeNetworkWait` turns a state and the kinds of work a run still has into a `NetworkWaitState`: the run is "waiting" (`WAITING_FOR_NETWORK` or `WAITING_FOR_PROVIDER`, the waits of `src/shared/progress.ts`) only when nothing that is left can go on; otherwise it names what waits and what continues.

An error from a provider is read with `classifyTransportError`: `NETWORK` (Node codes such as ENOTFOUND, EAI_AGAIN, ECONNRESET, ETIMEDOUT, ENETUNREACH, EHOSTUNREACH, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, "fetch failed", TLS handshake and certificate errors), `PROVIDER_OUTAGE` (500, 502, 503, 504, 529), `QUOTA` (429, with or without Retry-After), `AUTH` (401, 403) or `OTHER`. A `NETWORK` error is a reason to look (`supervisor.notifyNetworkError`) and, if the supervisor then says the network is down, to wait. If the supervisor says ONLINE, repeated NETWORK errors (a TLS certificate problem, a refused port) are not an outage: the orchestrator should retry a bounded number of times and then fail the task as it would any other error. Waiting for ever on a permanent fault is not resilience.

## Supervision

`ConnectivitySupervisor` probes every 60 s while the network is fine, at once on a Windows connection notification or a network-classified error, and on a backoff of 5 s doubling to a 5 min cap (jitter only shortens a delay, so the cap holds) while the network is down. Any change notification restarts the backoff. A changed state must hold for 5 s over agreeing probes before it is published, so a flapping link is not a series of outages; the exception is a hard Wi-Fi disconnect event while ONLINE, which is published as soon as the probe after it agrees.

Events: `state` (every change), `outage-started`, `restored` (once per outage, with the closed record and its diagnosis text).

## Outages and what the diagnosis can say

`NetworkOutage` records: when it was first seen and when it ended, the states passed through, the reconnect attempts with times and outcomes, the WLAN reason codes seen, and the evidence at the start and at the end. `diagnoseOutage` writes text from those facts only: durations, states, what each probe returned, the reason codes by name, the attempts. It always ends "The cause beyond these observations was not determined." It never says "router", "ISP" or any other cause the machine has no evidence of. It cannot say why Windows lost the link beyond the reason code Windows gave, and it cannot tell a local fault from one further away.

## Reconnecting (recovery)

`NetworkRecoveryManager` acts only in `WLAN_DISCONNECTED`. After a 20 s grace (Windows' own auto-connect, and a "disconnected by user" notification, get there first) it asks Windows to connect the primary profile (the one connected when the work began) and then the approved backups in order, at most `maxAttempts` (6) requests per outage, with a backoff of 10 s doubling to 2 min, looking at the interface every 2 s for 15 s after each request.

Hard rules, each with a test:

- It names only a profile that Windows lists as saved right now AND is the primary or on the approved list.
- It never connects an open network (Windows profiles with open authentication and no encryption, or Enhanced Open), nor a profile whose security could not be read, even if it is on the list. The helper refuses these too.
- It never creates, edits, exports or deletes a profile, and it never reads or handles a key. The helper does not declare any function that could, and a test reads the source for them.
- It does nothing when the policy is off (read again at every attempt), when a wired link has an address, or when the disconnect was the user's own. A user disconnect is recognised by its WLAN reason code (`wlan-reasons.ts`: code 0 and the user-refusal codes); it is respected for the rest of the outage and recorded as `SKIPPED_USER_DISCONNECT`.
- It is ordinary operational recovery: it creates no approval and no boundary request and imports nothing from that machinery.
- A profile name goes to the helper as one argv element (no shell, no string building) after being checked against the saved list read a moment before; names with control characters or over 255 characters are never passed.

Never done, by design: connecting to an arbitrary or unknown Wi-Fi, joining an open Wi-Fi, creating a profile, reading a password, changing Windows' auto-connect settings, using a hotspot that is not already a saved profile the user approved.

## What the user can configure

`NetworkRecoveryPolicy`: enabled (default on, primary profile only), the primary profile (default: the one connected when work begins), an ordered list of approved backup profiles (chosen from the saved profiles, at most 8), maximum attempts (1 to 20), backoff bounds. `normalizeRecoveryPolicy` bounds whatever the settings panel sends.

## Staying awake

`OvernightPowerGuard` decides, purely, whether to hold the idle-sleep request: yes while an Overnight run, a Program, a Workspace run or a long-running mission is working or waiting for the network or provider; no when nothing autonomous is active, everything is paused by the user, or everything left waits on the user. It releases at once when not needed and never holds for ever: after 6 h without progress it releases, records why, and does not hold again until some work makes progress. The mechanism is the runtime's existing `powerSaveBlocker('prevent-app-suspension')`, which asks Windows only that the machine not idle-sleep ("system required"); the display may turn off, and a sleep the user asks for (the Sleep command, closing the lid, the power button, a low-battery action) is not blocked.

## Where outages are stored

The module works against an `OutageStore` (`save` upsert, `recent`). An in-memory one is provided; the runtime backs it with a table (see the proposal in the handover: `network_outages`, one row per outage, JSON columns for the lists).

## Not tested on a real network

Everything above is tested with fakes (fake clock, fake Wi-Fi adapter, fake probe IO). On the real machine only the helper's read-only `status` and `profiles` were run. Not verified:

- `connect` and `watch` of the helper were never run against Windows. The notification layouts (offsets of the profile name and reason code in `WLAN_CONNECTION_NOTIFICATION_DATA`) come from the SDK header and were not confirmed.
- Which reason code Windows reports when the USER disconnects (the table assumes 0, `WlanDisconnect` success) is unconfirmed; the table errs towards not reconnecting.
- The real probes (`tls.connect` to Cloudflare, Google, 1.1.1.1, 8.8.8.8 and provider hosts) were not run against a failing network; behaviour behind a captive portal, a corporate proxy that intercepts TLS, a VPN, or IPv6-only networks is unknown.
- The wired-link heuristic (a non-virtual adapter with a non-link-local IPv4 address) is a guess by adapter name.
- Whether Windows allows `WlanConnect` to a profile whose connection mode is manual when no user is at the console, after sleep/resume, or under a locked session is untested. On this machine the current profile is "connect manually", so Windows will not reconnect it by itself.
- The effect of the power guard across a real sleep/resume was not exercised.
