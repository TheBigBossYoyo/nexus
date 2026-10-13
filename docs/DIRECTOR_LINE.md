# Director Line

The Director Line lets you talk to NEXUS while you are away from the PC, and lets NEXUS report back. It is a module (`src/main/modules/director-line/`, types in `src/shared/director-line.ts`) that works against injected functions and stores. It has no code path to the capability broker, to settings, to power or to run creation, so what it can do is exactly what the runtime injects.

Status of this document: written with the module, before it was wired into the runtime. "Implemented" means code with unit tests against fake transports. Nothing was tested against a real Telegram, Twilio or WhatsApp service.

## Providers

| Channel | Kind | State |
|---|---|---|
| Telegram (Bot API, long polling) | text, inbound and outbound | implemented, not tested against the real service |
| Voice over standard SIP (Linphone), both directions | voice | since 0.9.1; see "Voice is SIP since 0.9.1" |
| Twilio SMS, WhatsApp Business Platform, e-mail | text | type names only, no code |

Why Telegram long polling is the recommended first text channel: `getUpdates` is an outbound HTTPS request, so the PC opens no port, needs no public URL and no tunnel. The Bot API does not allow `getUpdates` while a webhook is set; this provider never sets one. Updates are kept by Telegram until received, but not longer than 24 hours (Bot API page), so a PC off for a day loses the oldest ones; that is acceptable here.

WhatsApp would deliver inbound traffic only to a public HTTPS URL. The PC has none and must not get one.

## Setting it up (for you)

Telegram:

1. In Telegram, talk to BotFather, create a bot, copy its token. The token is a password.
2. In NEXUS, Settings, Director Line: paste the token. It is stored in protected storage (Electron `safeStorage`) and never shown again; Settings shows only "configured" and the last four characters.
3. Press "Start pairing". NEXUS shows a code like `K7QM-2XTA-9PDR` for 10 minutes. It is shown once and only its hash is stored.
4. On your phone, open your bot and send the code (or `/start CODE`). The chat that sends the right code becomes the paired operator. NEXUS answers "Paired."
5. Press "Send test message" to check. "Unpair" ends the operator's authority at once.

Rules around the code: at least 12 random base32 characters (60 bits), single use, expires after 10 minutes, five wrong codes from a chat and that chat is ignored for 30 minutes, and 40 wrong codes in total burn the code. Text that does not look like a code costs nothing and reveals nothing (there is no oracle for whether a pairing is open).

Voice (when you choose to set it up, since 0.9.1): create two free accounts at sip.linphone.org, sign in to the Linphone app on your phone with one, and enter the other (NEXUS's address and password) and your phone's address in Settings. Choose a PIN of 6 to 12 digits (stored as a salted scrypt hash, per-install salt). A SIP address alone is never authority unless you turn the PIN off and the SIP service itself establishes who is calling.

## What a paired remote operator can and cannot do

| Can | Cannot (answer: "must be decided at the machine. Nothing was done.") |
|---|---|
| Ask status, time remaining, blockers, details of a project, latest test results | Push, publish, deploy |
| Pause after the current task, continue | Delete or wipe anything |
| Add a task after the current program, create a task for a project: the text goes to `submitIntent` as a `RawUserIntent` with `source: 'OPERATOR_REMOTE'`, through the ordinary creation path (Task Compiler and CapabilityBroker) | Disable the sandbox, change the autonomy profile, switch off a protection |
| Ask for help | Allow, grant or approve a boundary request (a grant needs the native confirmation at the machine) |
| | Shut down, hibernate, change power |
| | Ask for or send credentials |
| | Run a command or script |
| | Create a task by voice (speech recognition errs) |

The operator's words are carried as the user's words, and nothing in them can change authority, by construction: the module imports nothing that could. A message that matches a high-authority topic is turned into a fixed refusal, an optional `recordNote` callback receives the topic and a 120-character inert snippet, and no action function is called. This includes task text: "create a task for X: push the release" is refused, not queued. It also catches ordinary words like "delete" and "token" in tasks; such tasks are written at the machine. This is deliberately conservative.

Messages from any chat that is not paired are UNTRUSTED_EXTERNAL: never interpreted, never shown to a model, never create a task. They get at most one fixed reply, "This NEXUS is not paired with this chat.", at most once per 10 minutes per chat. A chat in its pairing cooling period gets no reply.

Authentication has two separate notions in the types: `providerAuthenticated` (the provider vouches for the delivery: TLS to the provider, or a verified webhook signature) and `trust` (the paired human wrote it). A signature never makes a message authoritative.

Interpretation is deterministic first (English and French, case, punctuation and diacritics insensitive). An optional `classify` hook may be given for what the patterns miss: it only chooses among the same closed set (it cannot choose the refusal kind), a task text it extracts must appear word for word in your message, the danger scan runs on it, and it is never called for a message that already matches a dangerous topic. Without the hook an unrecognised message gets a short help reply.

## What NEXUS reports, and when

Defaults (`DEFAULT_COMMUNICATION_POLICY`):

| Event | On | Call |
|---|---|---|
| Morning overnight report | yes | no |
| Program complete | yes | yes |
| Mission blocked longer than 30 min | yes | yes |
| Security boundary required | yes | no |
| Network offline longer than 60 min | no | no |
| Critical failure | yes | yes |
| ETA slipped by 25 percent | no | no |

Calls are used only when a voice provider is configured and paired, once per report (`maxCallAttempts` default 1). If the call is not answered, busy or failed, exactly one fallback message follows and the call is never repeated; the attempt is counted before dialling, so a crash during the call cannot cause a second one. Progress messages are never phoned. Order of channels: phone, message, local notification (changeable).

Remote progress messages: at most one per 45 minutes (`minProgressIntervalMinutes`; 0 turns them off), never the UI's 5-minute refresh, never the same text twice. The runtime decides what is a meaningful change; the line enforces the interval.

Quiet hours (default 22:30 to 07:00, zone `UTC` until set; set the real zone, for example `Europe/Paris`): evaluated with `Intl` in the zone at the moment of the event, so daylight saving is the zone's. Non-critical reports are held in the outbox and released by the next `flush()` after the window. Critical failure and security boundary events pass through only if `criticalBreaksQuiet` is set. An unknown zone name is treated as quiet.

Offline queue: reports made while the PC has no Internet are stored in the outbox. When connectivity returns, `flush()`: drops reports older than 12 hours (progress: older than twice its interval); collapses pending reports about the same subject into one ("completed ... It had been blocked earlier and is no longer.", or "3 similar notices combined"); and turns more than three different subjects into one digest message. Each kind is also rate limited per subject (blocked: 30 min, network: 60 min, and so on). The runtime must call `flush()` about once a minute and when connectivity returns. While offline nothing is sent, not even the local notification.

Every attempt, including suppressions, drops and collapses, is a `DeliveryAttempt` row.

Nothing here uses a strong model. Status text is templates over `ProgressSnapshot` (range, confidence, waits kept apart from active time: "24-35 min of active work remain. Waiting for the Internet; when it ends is not known."). An optional `summarize` may rephrase; it gets only the template text, its output is capped at 600 characters and loses any URL it was not given.

## Privacy

Stored: the paired identity (channel, provider id, label), hashes of the pairing code and PIN, the install salt, attempt counters, the seen-set of update ids (keys only, pruned by age), the outbox, delivery attempts, the policy, the Telegram offset. Not stored by this module: tokens and secrets (the runtime keeps them in `safeStorage`), message text of replies, call audio, call transcripts. Calls are not recorded (`Record=false` is sent explicitly; `recorded` is always false). For voice, a transcript is kept only as the structured intent. Messages travel through the provider (Telegram or Twilio) in the clear to them: do not expect confidentiality from the provider. If a voice flow uses Twilio speech recognition (`<Gather input="speech">`), Twilio processes the speech; this implementation gathers keypad digits only, and spoken choices would arrive through the relay as text Twilio recognised, which is a provider speech-processing step you should accept before enabling it.

Errors leaving the Telegram code are reduced to a class (`NETWORK`, `RATE_LIMITED`, `AUTH`, `PROVIDER`, `REJECTED`, `NOT_CONFIGURED`). The Telegram URL contains the token, so no transport error message is ever kept, logged or returned.

Text sent out is plain text only: no `parse_mode`, link previews off, control and bidirectional characters removed, project-derived strings flattened to one line. Messages over the limit are split in at most three parts and then cut with a note.

## Cost

Voice over SIP costs nothing on a free sip.linphone.org account. NEXUS never signs up for a service and never spends on its own; every provider stays unconfigured until you enter credentials. Telegram bots are free.

## Voice is SIP since 0.9.1

Voice is standard SIP, carried by the Linphone SDK in a separate helper process: the owner's phone runs the Linphone app with a free sip.linphone.org account, NEXUS has its own SIP account, and either side can call the other. A call that comes in and a call NEXUS places end in the same live conversation. The Twilio voice path (a call that says a report and hangs up), the relay design and the relay protocol were removed; stored rows that name `TWILIO_VOICE` are read as not configured and nothing acts on them. The SIP password lives only in protected storage (`sip.password`); the non-secret configuration and the call records (never what was said; the newest 200) are in the tables of migration 021. The IPC channels are `directorLine.setSip`, `removeSip`, `setVoicePolicy`, `callMe`, `hangUpCall` and `confirmCallSas`.

What a call is trusted for (review of 0.9.1). A registered helper opens no listening socket (the transport in use is told not to bind, the others are off), so a request can only arrive on the connection to the SIP server; only then, and only when the helper has said so, is the caller `TRANSPORT_AUTHENTICATED`. UDP is refused for a registered account. TLS is the hop to the SIP server and nothing more. A call is `endToEnd` only for ZRTP whose four-character string was compared with the telephone's (Settings, "They match", confirmed natively) or whose retained secrets match an earlier verified call; SRTP keys are known to the server and DTLS-SRTP fingerprints travel through it. When the owner refuses calls that are not encrypted, nothing is said or heard until the media shows it is (5 s), and a call that does not is ended and recorded as failed. A call NEXUS places says only that it has something to tell until the PIN is accepted. Strangers are counted in memory only (five declined calls in 30 minutes, then hung up on without a record); the times of the calls NEXUS placed in the last day are kept (migration 022) so that the daily limit survives a restart.

## Implemented and designed

Implemented, with tests: types and policy defaults; provider interface and fake; Telegram provider (long polling, offset, 429, sanitisation, private chats only, plain text, splitting); pairing (code, attempts, cooling, one operator per channel, unpair, phone and PIN, scrypt); intent patterns (English, French), refusal of dangerous topics, classifier validation; `DirectorLine` (dedupe by update id and message id with a durable seen-set, authentication, replies from templates, task hand-off, outbox with offline queue, stale drop, collapse, digest, quiet hours, rate limits, call then one fallback, local notification); Twilio outbound call with polling and cancel of a ringing call; TwiML builder; envelope seal/open; relay client.

Designed only: WhatsApp; e-mail; Twilio SMS (type names only); per-install encryption of the offset; retention pruning schedule.

## Sources read and what could not be verified

Read on 2026-10-13:

- Telegram Bot API, https://core.telegram.org/bots/api (shows Bot API 10.3, August 24, 2026): `getUpdates` offset semantics (an update is confirmed when `getUpdates` is called with an offset higher than its `update_id`), `timeout`, `allowed_updates`, retention of at most 24 hours, `Chat.type` values, `getMe`, no `getUpdates` while a webhook is set.

Could not be verified from what was read: the fetched Bot API page was truncated before `sendMessage`, so the 4096-character text limit, `link_preview_options` and the `retry_after` field of `ResponseParameters` for HTTP 429 are taken from the author's prior knowledge of the API and not confirmed against the page; the Twilio signature output encoding (base64) is inferred; Twilio's `<Say>`/`<Gather>` TwiML attributes, the cancel call (`Status=canceled` on the call resource) and the polling of `Calls/{sid}.json` were not read on the pages above; the WhatsApp Business Platform was not read at all and has no code; Twilio account verification or geographic permission requirements for outbound calls to your country were not checked. Test everything below with a real bot and a real account before relying on it.

## Persistence the module needs

```sql
CREATE TABLE director_line_identities (
  channel TEXT NOT NULL, provider_user_id TEXT NOT NULL, label TEXT NOT NULL,
  paired_at TEXT NOT NULL, paired_via TEXT NOT NULL,
  PRIMARY KEY (channel, provider_user_id)
);
CREATE TABLE director_line_pairing_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  install_salt TEXT,
  code_channel TEXT, code_hash TEXT, code_expires_at TEXT, code_wrong_attempts INTEGER,
  pin_hash TEXT,
  attempts_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE director_line_seen (
  key TEXT PRIMARY KEY, seen_at TEXT NOT NULL
);
CREATE INDEX director_line_seen_at ON director_line_seen (seen_at);
CREATE TABLE director_line_outbox (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, event_json TEXT NOT NULL,
  call_attempts INTEGER NOT NULL DEFAULT 0, message_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, quiet_noted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE director_line_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL, channel TEXT NOT NULL,
  at TEXT NOT NULL, outcome TEXT NOT NULL, provider_reference TEXT, error_class TEXT
);
CREATE INDEX director_line_deliveries_at ON director_line_deliveries (at);
CREATE TABLE director_line_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1), policy_json TEXT NOT NULL
);
CREATE TABLE director_line_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0,
  message_provider TEXT, voice_provider TEXT, telegram_offset INTEGER,
  relay_base_url TEXT
);
```

`SeenStore.addIfAbsent` must be one atomic statement (`INSERT OR IGNORE`, then check `changes`). `PairingState` may be stored as columns or as one JSON blob; the module loads and saves it whole.

## Settings IPC proposed

All inputs and outputs are zod-able plain objects; none carries a secret back to the renderer.

| Channel | Input | Output | Native confirmation |
|---|---|---|---|
| `directorLine.get` | none | `DirectorLineSettingsView` | no |
| `directorLine.setEnabled` | `{ enabled: boolean }` | view | yes when turning on (it opens a channel to the outside) |
| `directorLine.setProvider` | `{ kind: 'TELEGRAM'; secret: string \| null }` (the token goes straight to protected storage; `null` removes it) | view | yes |
| `directorLine.setPolicy` | `{ policy: CommunicationPolicy }` | view | yes when it enables calls, disables quiet hours, sets `criticalBreaksQuiet`, or sets `requirePinForStatus` to false; no otherwise |
| `directorLine.startPairing` | `{ channel }` | `{ displayCode, expiresAt }` (the only time the code is returned) | yes |
| `directorLine.setPin` | `{ pin: string }` | `{ configured: true }` | yes |
| `directorLine.unpair` | `{ channel? }` | `{ removed: number }` | no (it only removes authority) |
| `directorLine.sendTestMessage` | none | `{ ok, errorClass }` | no |
| `directorLine.setSip` | `{ identity, password \| null (null keeps the stored one), operatorIdentity, mediaEncryption, mediaEncryptionMandatory, stunServer, ice }` | view | yes (it gives a phone authority) |
| `directorLine.removeSip` | none | view | yes |
| `directorLine.setVoicePolicy` | `{ requirePin, ringSeconds, maxPlacedCallsPerDay, minMinutesBetweenPlacedCalls }` | view | yes when `requirePin` is turned off, the calls per day are raised above 6 or the interval is lowered below 10 minutes |
| `directorLine.callMe` | none | `{ result }` | no (it calls only the paired address) |
| `directorLine.hangUpCall` | none | view | no |
| `directorLine.confirmCallSas` | none | view | yes (it shows the ZRTP verification code of the call in progress and asks whether the telephone shows the same four characters) |

The view holds enabled, the paired operator without the provider id, the message and voice provider kind with `configured`, the last four characters of the token at most, the connection status, the policy, and the last delivery. It has no field that could hold a token, a PIN or a pairing code.

## Where the token lives

The runtime keeps each secret in `safeStorage`, in the user data directory, and gives the module getters:

```ts
interface SecretStore {
  get(name: 'telegram.botToken' | 'sip.password'): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}
```

`TelegramProvider` gets `getToken: () => secrets.get('telegram.botToken')`, called on each request. The voice provider is given a function that reads the SIP account, with the password from `sip.password`, each time it registers.
