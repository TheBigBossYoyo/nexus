# Operator Relay: protocol (0.9.1)

The relay is the one public thing in the Director Line's telephone path. Twilio can deliver a call only to a
public address; the PC has none and must not get one. The relay stands between them and does as little as can
be done there. This page is the contract between the relay (`relay/`, deployed by the owner) and NEXUS
(`src/main/modules/director-line/relay-link.ts`). Twilio's side of it is in
`TWILIO_CONVERSATIONRELAY_RESEARCH.md`.

## What the relay is and is not

It **may**: check that a webhook or a WebSocket really comes from Twilio; answer an incoming call with the TwiML
that starts a ConversationRelay session; hold that session's WebSocket; pass what the caller said or pressed to
NEXUS and what NEXUS says back to Twilio; hold a few seconds of messages while NEXUS reconnects.

It **must not** and cannot: hold a Claude or OpenAI credential, read a repository, run a task, grant a
capability, change a policy of NEXUS, or run a command. It has no code path to any of these: it knows three
things (Twilio's auth token, NEXUS's two public keys, one bearer secret) and speaks two protocols.

A relay that is taken over can listen to a call and can speak nonsense into it. It cannot make NEXUS do
anything a caller without the PIN could not do: authority is the paired number plus the PIN, checked by NEXUS,
never by the relay.

## Secrets and where they live

| Secret | Relay | NEXUS |
|---|---|---|
| Twilio Auth Token (validates Twilio's signatures; Twilio offers no other way) | yes, as an environment variable | no |
| Twilio API key SID and secret (place calls) | no | yes, protected storage |
| Link bearer (NEXUS proves itself when it connects) | its SHA-256 only | yes, protected storage |
| NEXUS sealing key pair (X25519): relay to NEXUS messages are sealed to it | public key | private key, protected storage |
| NEXUS signing key pair (Ed25519): NEXUS to relay messages are signed with it | public key | private key, protected storage |

The relay's configuration is five environment variables: `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_SID` (to refuse
another account's traffic), `PUBLIC_BASE_URL` (the `https://` address Twilio is configured with, used to rebuild
the signed URL exactly), `NEXUS_SEAL_PUBLIC_KEY`, `NEXUS_SIGN_PUBLIC_KEY`, `NEXUS_BEARER_SHA256`. Optional:
`PORT` (default 8080), `ALLOWED_TO` (the Twilio number; an incoming call to another number is refused).

## Endpoints of the relay

| Endpoint | Who calls it | What it does |
|---|---|---|
| `GET /healthz` | anybody | `200 ok`. Says nothing else. |
| `POST /twilio/voice` | Twilio, when a call comes in | Validates `X-Twilio-Signature`. If NEXUS is not connected: TwiML that says "NEXUS is not reachable right now. Goodbye." and hangs up. Otherwise TwiML `<Connect action="{base}/twilio/ended"><ConversationRelay url="wss://{host}/twilio/cr" dtmfDetection="true" interruptible="any" …><Parameter name="k" value="{one-time key}"/></ConversationRelay></Connect>`. No greeting in the TwiML: NEXUS decides the first words. |
| `POST /twilio/ended` | Twilio, when a session ends | Validates the signature; tells NEXUS `call.ended`; answers `<Response><Hangup/></Response>`. |
| `WS /twilio/cr` | Twilio (ConversationRelay) | Validates `X-Twilio-Signature` on the upgrade (tries the configured `wss://` URL, its `https://` form, each with and without a trailing slash, and with the query string as received; logs which matched, never the token). After `setup`: the `accountSid` must be the configured one and the `customParameters.k` must be a key the relay issued (incoming call) or NEXUS announced (outgoing call), unused, younger than 2 minutes. Anything else: close. |
| `WS /nexus` | NEXUS, outbound from the PC | The link. One connection at a time; a new authenticated one replaces the old. |

## The link (NEXUS to relay, WebSocket, JSON text frames)

1. NEXUS connects to `wss://{host}/nexus` with the header `Authorization: Bearer {link bearer}`. The relay
   compares the SHA-256 in constant time and refuses otherwise (HTTP 401, no detail).
2. The relay sends `{"t":"hello","nonce":"<32 random bytes, base64>","relayTime":<ms>}`.
3. NEXUS answers `{"t":"hello-ack","sig":"<Ed25519 signature, base64, over the UTF-8 bytes of 'nexus-relay-hello-v1|' + nonce>"}`.
   The relay verifies it with `NEXUS_SIGN_PUBLIC_KEY` and closes the connection if it does not hold. A stolen
   bearer alone therefore does not make a link.
4. After that, both directions carry the messages below. Every 20 seconds NEXUS sends `{"t":"ping"}` and the
   relay answers `{"t":"pong"}`; a side that hears nothing for 60 seconds closes.

### Relay to NEXUS

Each is `{"t":"env","e":<OperatorEnvelope>}`: the payload sealed to NEXUS's sealing key (`sealEnvelope` in
`relay.ts`: X25519, HKDF-SHA256, AES-256-GCM, a random id and a timestamp in the authenticated data). NEXUS
opens it with `openEnvelope`, which refuses a stale one (older than 5 minutes) and a repeated id.

The payload (`RelayEvent`), a JSON object:

| `kind` | Fields | When |
|---|---|---|
| `call.started` | `callSid`, `sessionId`, `direction` (`inbound` or `outbound`), `from`, `to`, `key` | Twilio's `setup` passed the checks. For an outbound call `key` is the one NEXUS announced. |
| `call.prompt` | `callSid`, `seq`, `text`, `lang`, `last` | The caller said something (Twilio's `prompt`). Only `last: true` prompts are sent. |
| `call.dtmf` | `callSid`, `seq`, `digit` | A key was pressed. |
| `call.interrupt` | `callSid`, `seq` | The caller spoke over what was being said. |
| `call.ended` | `callSid`, `reason` (`completed`, `failed`, `relay-closed`, `nexus-ended`), `errorCode?` | The session is over. |

`seq` counts from 1 per call. The relay keeps at most 50 events or 30 seconds per call while the link is down
and sends them, in order, when it is back; older ones are dropped and the call is ended with a sentence
("NEXUS is not reachable right now. Goodbye.") if the link stays down for 15 seconds.

### NEXUS to relay

Each is `{"t":"cmd","c":<RelayCommand>,"sig":"<Ed25519 signature, base64, over the UTF-8 bytes of the canonical JSON of c>"}`.
Canonical JSON: the object's keys in alphabetical order, no whitespace, strings as `JSON.stringify` writes them.
The relay verifies the signature, refuses a command whose `ts` is more than 60 seconds from its clock or whose
`id` it has seen, and otherwise carries it out.

| `kind` | Fields | What the relay does |
|---|---|---|
| `call.expect` | `id`, `ts`, `key`, `to` | Remembers for 2 minutes that an outgoing call to `to` will arrive with this key. |
| `call.say` | `id`, `ts`, `callSid`, `text`, `last`, `interruptible` | Sends Twilio `{"type":"text","token":text,"last":last,"interruptible":interruptible}`. `text` is at most 1,000 characters. |
| `call.end` | `id`, `ts`, `callSid` | Sends Twilio `{"type":"end"}` and closes the session. |

The relay sends nothing to Twilio that NEXUS did not sign, except the two fixed sentences above.

## An incoming call, step by step

1. Twilio posts to `/twilio/voice`. The relay validates the signature and answers with the TwiML and a one-time key.
2. Twilio opens `/twilio/cr`. The relay validates the handshake, then the `setup` message, and sends NEXUS `call.started`.
3. NEXUS starts a voice session for `from`. If the number is not paired it signs `call.say` ("This number is not
   available. Goodbye.") and `call.end`. Otherwise it asks for the PIN.
4. `call.prompt` and `call.dtmf` go to NEXUS; `call.say` comes back. NEXUS ends the call with `call.end`.
5. Twilio posts to `/twilio/ended`; the relay sends `call.ended`.

## A call NEXUS places, step by step

1. NEXUS signs `call.expect` with a fresh key and the operator's number.
2. NEXUS asks Twilio (REST, with its API key) for a call to the operator, with inline TwiML: the same
   `<Connect><ConversationRelay url="wss://{host}/twilio/cr" …><Parameter name="k" value="{key}"/>`.
3. When the operator answers, Twilio opens `/twilio/cr`; the relay finds the key and sends `call.started` with
   `direction: outbound`. NEXUS says the report and the conversation goes on as above.
4. No answer, busy or failed: Twilio never opens the WebSocket; NEXUS reads the call's final status from the
   REST API, stops a call that still rings after the ring time, and falls back to one message.

## What is not recorded

The relay writes one log line per call (call SID, direction, duration, end reason) and one per refused request
(which check failed). It never logs what was said, a digit, a token, a key or a telephone number in full (last
three digits only). It keeps nothing on disk. Twilio is asked not to record (`Record=false`); speech
recognition and speech synthesis are done by Twilio's providers, which is said to the user in Settings.
