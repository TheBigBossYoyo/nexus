# Director Line

The Director Line lets you talk to NEXUS while you are away from the PC, and lets NEXUS report back. It is a module (`src/main/modules/director-line/`, types in `src/shared/director-line.ts`) that works against injected functions and stores. It has no code path to the capability broker, to settings, to power or to run creation, so what it can do is exactly what the runtime injects.

Status of this document: written with the module, before it was wired into the runtime. "Implemented" means code with unit tests against fake transports. Nothing was tested against a real Telegram, Twilio or WhatsApp service.

## Providers

| Channel | Kind | State |
|---|---|---|
| Telegram (Bot API, long polling) | text, inbound and outbound | implemented, not tested against the real service |
| Twilio Programmable Voice, outbound report call | voice | implemented, unconfigured until credentials exist, not tested against the real service |
| Twilio voice with keypad PIN and spoken choice | voice, inbound | designed (needs the relay); envelope format, client and line-side handling implemented and tested |
| Twilio SMS, WhatsApp Business Platform, e-mail | text | type names only, no code |

Why Telegram long polling is the recommended first text channel: `getUpdates` is an outbound HTTPS request, so the PC opens no port, needs no public URL and no tunnel. The Bot API does not allow `getUpdates` while a webhook is set; this provider never sets one. Updates are kept by Telegram until received, but not longer than 24 hours (Bot API page), so a PC off for a day loses the oldest ones; that is acceptable here.

Twilio and WhatsApp deliver inbound traffic only to a public HTTPS URL. The PC has none and must not get one. That is what the relay design below is for.

## Setting it up (for you)

Telegram:

1. In Telegram, talk to BotFather, create a bot, copy its token. The token is a password.
2. In NEXUS, Settings, Director Line: paste the token. It is stored in protected storage (Electron `safeStorage`) and never shown again; Settings shows only "configured" and the last four characters.
3. Press "Start pairing". NEXUS shows a code like `K7QM-2XTA-9PDR` for 10 minutes. It is shown once and only its hash is stored.
4. On your phone, open your bot and send the code (or `/start CODE`). The chat that sends the right code becomes the paired operator. NEXUS answers "Paired."
5. Press "Send test message" to check. "Unpair" ends the operator's authority at once.

Rules around the code: at least 12 random base32 characters (60 bits), single use, expires after 10 minutes, five wrong codes from a chat and that chat is ignored for 30 minutes, and 40 wrong codes in total burn the code. Text that does not look like a code costs nothing and reveals nothing (there is no oracle for whether a pairing is open).

Voice (when you choose to set it up): enter your Twilio account SID, an API key SID and secret, the Twilio number to call from, and your own number in international format. Choose a PIN of 6 to 12 digits (stored as a salted scrypt hash, per-install salt). A phone number alone is never authority.

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

Errors leaving the Telegram and Twilio code are reduced to a class (`NETWORK`, `RATE_LIMITED`, `AUTH`, `PROVIDER`, `REJECTED`, `NOT_CONFIGURED`). The Telegram URL contains the token, so no transport error message is ever kept, logged or returned.

Text sent out is plain text only: no `parse_mode`, link previews off, control and bidirectional characters removed, project-derived strings flattened to one line. Messages over the limit are split in at most three parts and then cut with a note.

## Cost

PSTN calls cost money on your own Twilio account, as do Twilio numbers and SMS. NEXUS never signs up for a service and never spends on its own; every provider stays unconfigured until you enter credentials. Telegram bots are free.

## OperatorRelay (designed; client and envelope implemented; no server)

A call or an SMS to a Twilio number is delivered by Twilio to a public HTTPS URL. A narrow relay (a small hosted function you would deploy yourself, not part of NEXUS) would:

1. receive Twilio's webhook and verify `X-Twilio-Signature` (this authenticates Twilio, not the caller);
2. seal the result (from-number, digits, call sid, status) into an envelope and queue it;
3. answer Twilio with TwiML that gathers the PIN, and keep nothing else.

NEXUS fetches the queue with an outbound HTTPS GET (`OperatorRelayClient.pollOnce`), opens each envelope, acknowledges everything it fetched (forged and stale ones too), and passes valid ones to `DirectorLine.handleVoiceInput`. The relay holds no project file, no model credential, issues no NEXUS capability, executes nothing and is not a shell. It cannot be asked anything by NEXUS beyond "give me the queue" and "acknowledge these ids".

Envelope: `{ v: 1, id, ts, epk, iv, ct, tag }`. Sealed to NEXUS's X25519 public key: an ephemeral X25519 key agreement, HKDF-SHA256, AES-256-GCM; `v|id|ts|epk` is the authenticated associated data. The relay holds only the public key, so it can seal but not read the queue. Opening checks, in order: shape, timestamp within 5 minutes either way, authenticated decryption, then the replay check (`envelope:<id>` in the seen-set, only after authentication so junk cannot fill it). A tampered `ts` or `id` fails decryption.

Limits, said honestly: an envelope proves that whoever holds the relay's configuration sealed it, not that a human spoke. A compromised relay can forge an envelope, which is why voice still needs the paired number AND the PIN with a 3-attempt limit and a 30-minute lock, why no task can be created by voice, and why dangerous requests are refused as in text. Caller ID can be spoofed, which is why the number alone is never enough (the "no PIN for status" setting exists but is off by default and allows reading only).

Not built: the relay server, its deployment, Twilio webhook signature verification code (the algorithm is HMAC-SHA1 over the URL plus the sorted POST parameters with the auth token, per Twilio's page; the relay's author should use Twilio's SDK validator as Twilio recommends), the inbound-call TwiML flow that sequences PIN then choice.

## Implemented and designed

Implemented, with tests: types and policy defaults; provider interface and fake; Telegram provider (long polling, offset, 429, sanitisation, private chats only, plain text, splitting); pairing (code, attempts, cooling, one operator per channel, unpair, phone and PIN, scrypt); intent patterns (English, French), refusal of dangerous topics, classifier validation; `DirectorLine` (dedupe by update id and message id with a durable seen-set, authentication, replies from templates, task hand-off, outbox with offline queue, stale drop, collapse, digest, quiet hours, rate limits, call then one fallback, local notification); Twilio outbound call with polling and cancel of a ringing call; TwiML builder; envelope seal/open; relay client.

Designed only: relay server; inbound voice flow; Twilio SMS; WhatsApp; e-mail; persistence (SQLite) implementations of the stores; the Settings screen; the runtime wiring; per-install encryption of the offset; retention pruning schedule.

## Sources read and what could not be verified

Read on 2026-10-13:

- Telegram Bot API, https://core.telegram.org/bots/api (shows Bot API 10.3, August 24, 2026): `getUpdates` offset semantics (an update is confirmed when `getUpdates` is called with an offset higher than its `update_id`), `timeout`, `allowed_updates`, retention of at most 24 hours, `Chat.type` values, `getMe`, no `getUpdates` while a webhook is set.
- Twilio Call resource, https://www.twilio.com/docs/voice/api/call-resource: create-call endpoint `POST /2010-04-01/Accounts/{AccountSid}/Calls.json`, `To`, `From`, `Url` or `Twiml`, `StatusCallback` and events, `Record` defaults to false, `CallStatus` values, HTTP Basic with API key SID and secret.
- Twilio webhook security, https://www.twilio.com/docs/usage/webhooks/webhooks-security: `X-Twilio-Signature` is HMAC-SHA1 with the auth token over the URL and the sorted parameters; JSON bodies add `bodySHA256`.

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
| `directorLine.setProvider` | `{ kind: 'TELEGRAM' \| 'TWILIO_VOICE'; secret: string \| null; extra?: { fromNumber?: string; accountSid?: string; apiKeySid?: string; relayBaseUrl?: string } }` (secret goes straight to protected storage; `null` clears) | view | yes |
| `directorLine.setPolicy` | `{ policy: CommunicationPolicy }` | view | yes when it enables calls, disables quiet hours, sets `criticalBreaksQuiet`, or sets `requirePinForStatus` to false; no otherwise |
| `directorLine.startPairing` | `{ channel }` | `{ displayCode, expiresAt }` (the only time the code is returned) | yes |
| `directorLine.setPin` | `{ pin: string }` | `{ configured: true }` | yes |
| `directorLine.unpair` | `{ channel? }` | `{ removed: number }` | no (it only removes authority) |
| `directorLine.sendTestMessage` | none | `{ ok, errorClass }` | no |
| `directorLine.testCall` | none | `{ ok, errorClass }` | yes (it spends money) |

The view holds enabled, the paired operator without the provider id, the message and voice provider kind with `configured`, the last four characters of the token at most, the connection status, the policy, and the last delivery. It has no field that could hold a token, a PIN or a pairing code.

## Where the token lives

The runtime keeps each secret in `safeStorage`, in the user data directory, and gives the module getters:

```ts
interface SecretStore {
  get(name: 'telegram.botToken' | 'twilio.apiKeySecret' | 'relay.pollBearer' | 'relay.privateKey'): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}
```

`TelegramProvider` gets `getToken: () => secrets.get('telegram.botToken')`, called on each request. `TwilioVoiceProvider` gets `getCredentials`. The relay private key (from `generateRelayKeyPair()`) is stored the same way; only the public key leaves the PC.
