# Twilio ConversationRelay: what was read on 2026-10-13

From Twilio's own pages (dates are the pages'), read through a fetch tool that summarises pages, so shapes are
as extracted and the unverified points are marked. Code in `relay/` and `src/main/modules/director-line` is
written from this; where it says UNVERIFIED the code must tolerate either answer and log what it met.

## What it is

Twilio does speech recognition and speech synthesis; a WebSocket server of ours receives what the caller said as
text and sends back text to say. GA since 2025-05-14 (changelog). Before first use the account must accept the
AI/ML addendum: Console, Communications > Voice > Settings > Privacy & Security (older console: Voice >
Settings > General, "Predictive and Generative AI/ML Features Addendum"). Whether a trial account can use it:
UNVERIFIED. A trial account can only call verified numbers.

## TwiML (docs/voice/twiml/connect/conversationrelay, 2026-09-30)

```xml
<Response>
  <Connect action="https://host/twilio/ended">
    <ConversationRelay url="wss://host/twilio/cr" dtmfDetection="true" interruptible="any" language="en-US">
      <Parameter name="k" value="one-time-key"/>
    </ConversationRelay>
  </Connect>
</Response>
```

Attributes used here: `url` (required, `wss://`), `welcomeGreeting` (not used: NEXUS speaks first by a `text`
message), `language` (default `en-US`; sets speech and transcription language), `ttsProvider` (default
`ElevenLabs`; `Google`, `Amazon`), `voice`, `transcriptionProvider` (default `Deepgram` for accounts since
2025-09-12), `interruptible` (`none`, `dtmf`, `speech`, `any`; default `any`), `dtmfDetection` (`true` sends key
presses over the WebSocket), `reportInputDuringAgentSpeech` (default `none`), `hints` (comma-separated words),
`profanityFilter` (default `true`), `debug`. Nested `<Language code="fr-FR" …/>` declares another language that
may be switched to; nested `<Parameter name value>` arrives in `setup.customParameters`. Voice and language
cannot be changed by messages afterwards except with the `language` message among declared languages.

`<Connect action>`: when the session ends Twilio requests it with `AccountSid`, `CallSid`, `CallStatus`,
`From`, `To`, `Direction`, `SessionId`, `SessionStatus` (`ended` by us, `completed` when the caller hung up,
`failed` with `ErrorCode` and `ErrorMessage`), `SessionDuration`, `HandoffData`.

## WebSocket messages (docs/voice/conversationrelay/websocket-messages, 2026-09-30)

Twilio sends:

```json
{"type":"setup","sessionId":"VX…","accountSid":"AC…","parentCallSid":"","callSid":"CA…","from":"+18005550100","to":"+18005550101","forwardedFrom":"","callType":"PSTN","callerName":"","direction":"inbound","callStatus":"RINGING","customParameters":{"k":"…"}}
{"type":"prompt","voicePrompt":"Hi! Can you tell me about life?","lang":"en-US","last":true}
{"type":"dtmf","digit":"1"}
{"type":"interrupt","utteranceUntilInterrupt":"Life is a complex set of","durationUntilInterruptMs":460}
{"type":"error","description":"Invalid message received: …"}
```

We send:

```json
{"type":"text","token":"Hello world!","last":true,"interruptible":true,"preemptible":false}
{"type":"end","handoffData":"{}"}
{"type":"language","ttsLanguage":"fr-FR","transcriptionLanguage":"fr-FR"}
```

`token` is required and not null. An invalid message is dropped by Twilio with error 64107 and the session
goes on. If our server closes the socket while the call is in progress Twilio reports 64105; no reconnection is
documented, so the call is to be considered lost. Idle time-outs, maximum session length and size limits:
UNVERIFIED. For an outbound call `direction` in `setup`: the exact string is UNVERIFIED (`outbound-api` is what
the Calls API uses); treat anything that is not `inbound` as outbound and rely on the one-time key.

## Signatures (docs/usage/security, 2026-10-07)

`X-Twilio-Signature` = base64(HMAC-SHA1(primary Auth Token, base string)).

- HTTP POST with a form body: base string = the full URL as configured in Twilio (scheme, host, path, query;
  for voice over https no port) followed by every POST parameter, sorted by name (case-sensitive), each as name
  immediately followed by value, no separators.
- JSON body: the URL carries `bodySHA256` (hex SHA-256 of the raw body) and the base string is the URL alone.
- WebSocket upgrade: the header is sent on the handshake and validated "the same way"; the exact URL string is
  UNVERIFIED beyond "if it fails, try with a trailing slash". Try the configured `wss://` URL and its
  `https://` form, each with and without a trailing slash; log which matched.
- Only the Auth Token validates; an API key secret does not. A secondary Auth Token exists for rotation.
- No timestamp is in the signature and Twilio documents no replay protection: ours is the one-time key and the
  call SID seen once.

Behind a TLS terminator the URL must be rebuilt as Twilio was given it (`PUBLIC_BASE_URL`), not from the
internal request.

## Calls API (docs/voice/api/call-resource, 2026-06-22)

`POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls.json`, Basic auth with API key SID and
secret, form body: `To`, `From`, `Twiml` (inline, at most 4,000 characters; whether ConversationRelay is
accepted inline is UNVERIFIED and not forbidden anywhere), `Timeout` (ring seconds, default 60), `Record`
(default `false`), `StatusCallback`, `StatusCallbackEvent`, `MachineDetection` (`Enable`, `DetectMessageEnd`).
Final `CallStatus` values: `completed`, `busy`, `failed`, `no-answer`, `canceled`. A region other than US1 uses
hosts of the form `api.{edge}.{region}.twilio.com` (for example `api.dublin.ie1.twilio.com`) and credentials of
that region; whether ConversationRelay runs outside US1 is UNVERIFIED.

## Incoming calls

The webhook carries `From`, `To`, `CallSid`, `CallStatus`, `AccountSid`, `Direction` and more. A caller's number
is what the caller's network says it is: it is not proof of who calls.

## Cost (Twilio pricing pages, current as of August 2026)

ConversationRelay 0.07 USD per minute, voice on top. Outbound to a Tunisian mobile 1.2714 USD per minute
(landline 1.5995). A US local number 1.15 USD per month; inbound to it 0.0085 USD per minute. Outbound calls to
a country need Voice Geographic Permissions for it; Twilio flags Tunisia for toll fraud. Whether an individual
needs a regulatory bundle for a US number: UNVERIFIED.

## Hosting

The WebSocket server must be public over `wss://`. Twilio publishes no list of source addresses to allow. Its
own tutorial uses ngrok for development and Fly.io for production. Whether Twilio Functions can hold a
WebSocket: UNVERIFIED (assumed not).

## Speaking

Tokens can be streamed (`last: false`, then `last: true`); a single token gives a steadier pace. Write numbers,
symbols and dates as words. English `en-US`, French `fr-FR`.
