import { useEffect, useState, type ReactNode } from 'react'
import type { CommunicationPolicy } from '@shared/director-line'
import type { DirectorLineView } from '@shared/ipc'
import {
  useDirectorLine,
  useDirectorLineSetEnabled,
  useDirectorLineSetPin,
  useDirectorLineSetPolicy,
  useDirectorLineSetProvider,
  useDirectorLineStartPairing,
  useDirectorLineTestCall,
  useDirectorLineTestMessage,
  useDirectorLineUnpair,
} from '../../lib/queries-director-line'
import { formatDateTime } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import { Badge, Button, ErrorNote, Field, Input, Loading, NumberField, Toggle } from '../../components/ui'
import {
  CAN_AND_CANNOT,
  CLASS_LABEL,
  EVENT_LABEL,
  EVENT_ORDER,
  STATUS_WORDS,
  THRESHOLD_WORDS,
  EMPTY_VOICE_FORM,
  VOICE_COST_LINE,
  voiceFormInput,
  voiceFormProblems,
  type VoiceForm,
  clock,
  deliveryLine,
  isValidTimeZone,
  minuteToTime,
  moved,
  samePolicy,
  secondsLeft,
  timeToMinute,
} from './directorLineModel'

function Block({ title, children }: { title: string; children: ReactNode }) {
  const id = `dl-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <section className="flex flex-col gap-2" aria-labelledby={id}>
      <h3 id={id} className="m-0 text-body font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Checkbox({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  return (
    <label className="flex items-center gap-1.5" title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/** Settings, Director Line: talk to NEXUS from a phone, and have NEXUS report back. */
export function DirectorLineSettings() {
  const query = useDirectorLine()
  const setEnabled = useDirectorLineSetEnabled()
  const setProvider = useDirectorLineSetProvider()
  const setPolicy = useDirectorLineSetPolicy()
  const startPairing = useDirectorLineStartPairing()
  const unpair = useDirectorLineUnpair()
  const testMessage = useDirectorLineTestMessage()
  const testCall = useDirectorLineTestCall()
  const setPin = useDirectorLineSetPin()
  const [pin, setPinText] = useState('')
  const [pinAgain, setPinAgain] = useState('')

  const [token, setToken] = useState('')
  const [voice, setVoice] = useState<VoiceForm>(EMPTY_VOICE_FORM)
  const [voiceTried, setVoiceTried] = useState(false)
  const [code, setCode] = useState<{ displayCode: string; expiresAt: string } | null>(null)
  const [draft, setDraft] = useState<CommunicationPolicy | null>(null)
  const [announce, setAnnounce] = useState('')
  const now = useNow(code !== null)

  const view: DirectorLineView | undefined = query.data
  const paired = view?.pairedOperator ?? null
  const left = code ? secondsLeft(code.expiresAt, now) : 0

  // While a code is shown, look for the pairing to complete; hide the code when it has been used or has expired.
  const refetch = query.refetch
  useEffect(() => {
    if (!code) return
    const timer = setInterval(() => void refetch(), 3000)
    return () => clearInterval(timer)
  }, [code, refetch])
  useEffect(() => {
    if (!code) return
    if (paired) {
      setCode(null)
      setAnnounce('Paired.')
    } else if (left === 0) {
      setCode(null)
      setAnnounce('The pairing code expired.')
    }
  }, [code, paired, left])

  if (query.isPending) return <Loading label="Loading Director Line" />
  if (query.isError) return <ErrorNote error={query.error} />
  if (!view) return null

  const policy = draft ?? view.policy
  const dirty = draft !== null && !samePolicy(draft, view.policy)
  const zoneOk = isValidTimeZone(policy.quietHours.timeZone)
  const edit = (change: (p: CommunicationPolicy) => void): void => {
    const next = structuredClone(draft ?? view.policy)
    change(next)
    setDraft(next)
  }
  const failure = setEnabled.error ?? setProvider.error ?? setPolicy.error ?? startPairing.error ?? unpair.error ?? testMessage.error ?? testCall.error ?? setPin.error
  const working = setEnabled.isPending || setProvider.isPending || setPolicy.isPending || startPairing.isPending
  const voiceReady = view.voiceProvider.configured
  const status = view.messageProvider.status
  const tone = status === 'CONNECTED' ? 'success' : status === 'ERROR' ? 'danger' : 'neutral'

  const saveToken = (): void => {
    const secret = token.trim()
    if (secret === '') return
    setProvider.mutate({ kind: 'TELEGRAM', secret }, { onSuccess: () => { setToken(''); setAnnounce('Bot token stored.') } })
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="director-line-settings">
      <p className="m-0 text-text-secondary">
        Talk to NEXUS from your phone while you are away, and let it report back. Nothing is on until you turn it on, and nothing you send from the phone can widen what NEXUS is allowed to do.
      </p>
      <p className="m-0" data-testid="director-line-can-cannot">
        {CAN_AND_CANNOT}
      </p>

      {failure ? <ErrorNote error={failure} /> : null}
      <p role="status" className="m-0 min-h-5 text-small text-text-secondary" data-testid="director-line-announce">
        {announce}
      </p>

      <Block title="Director Line">
        <Toggle
          checked={view.enabled}
          busy={setEnabled.isPending}
          onChange={(on) => setEnabled.mutate({ enabled: on }, { onSuccess: () => setAnnounce(on ? 'Director Line turned on.' : 'Director Line turned off.') })}
          label="Enabled"
          description="Turning it on asks for your confirmation on this PC."
          data-testid="director-line-enabled"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Connection</span>
          <Badge tone={tone}>{STATUS_WORDS[status]}</Badge>
          <span role="status" className="text-text-secondary" data-testid="director-line-status">
            {view.statusReason}
          </span>
        </div>
      </Block>

      <Block title="Paired operator">
        {paired ? (
          <div className="flex flex-wrap items-center gap-3">
            <span>
              <span className="font-medium">{paired.label}</span>
              <span className="text-text-secondary"> since {formatDateTime(paired.pairedAt)}</span>
            </span>
            <Button
              variant="danger"
              loading={unpair.isPending}
              onClick={() => unpair.mutate({ channel: paired.channel }, { onSuccess: () => setAnnounce('Unpaired. That phone has no authority now.') })}
              data-testid="director-line-unpair"
            >
              Unpair
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-text-secondary">No phone is paired.</p>
            <div>
              <Button
                loading={startPairing.isPending}
                disabled={!view.enabled || !view.messageProvider.configured}
                onClick={() => startPairing.mutate({ channel: 'TELEGRAM' }, { onSuccess: (c) => { setCode(c); setAnnounce('A pairing code is shown. It works once.') } })}
                data-testid="director-line-pair"
                aria-describedby="dl-pair-why"
              >
                Pair
              </Button>
              {!view.enabled || !view.messageProvider.configured ? (
                <span id="dl-pair-why" className="ml-2 text-small text-text-muted">
                  Turn it on and store a bot token first.
                </span>
              ) : null}
            </div>
          </div>
        )}
        {code ? (
          <div className="flex flex-col gap-1 rounded-md border bg-surface-muted p-3" data-testid="director-line-pairing">
            <p className="m-0">Send this code to your bot from your phone.</p>
            <code className="select-all font-mono text-[28px] font-semibold tracking-widest" data-testid="director-line-code" aria-label={`Pairing code ${code.displayCode.split('').join(' ')}`}>
              {code.displayCode}
            </code>
            <p className="m-0 text-small text-text-secondary">
              Expires in {clock(left)} (at {formatDateTime(code.expiresAt)}). It works once, and is not shown again.
            </p>
          </div>
        ) : null}
      </Block>

      <Block title="Message provider: Telegram">
        <p className="m-0 text-text-secondary" data-testid="director-line-token-state">
          {view.messageProvider.configured ? `Bot token: configured ····${view.messageProvider.tokenSuffix ?? ''}` : 'Bot token: not configured'}
        </p>
        <Field label={view.messageProvider.configured ? 'Replace the bot token' : 'Bot token'} hint="Create a bot with BotFather in Telegram and paste its token. It is stored in protected storage and never shown again.">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveToken() }}
              data-testid="director-line-token"
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={setProvider.isPending} disabled={token.trim() === ''} onClick={saveToken} data-testid="director-line-save-token">
            Save token
          </Button>
          {view.messageProvider.configured ? (
            <Button variant="danger" busy={setProvider.isPending} onClick={() => setProvider.mutate({ kind: 'TELEGRAM', secret: null }, { onSuccess: () => setAnnounce('Bot token removed.') })}>
              Remove token
            </Button>
          ) : null}
        </div>
      </Block>

      <Block title="Voice provider: Twilio">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={voiceReady ? 'success' : 'neutral'}>{voiceReady ? `Configured ····${view.voiceProvider.tokenSuffix ?? ''}` : 'Ready, not configured'}</Badge>
          {voiceReady ? (
            <span className="text-text-secondary" data-testid="director-line-voice-state">
              Calls come from the number ending {view.voiceFromSuffix ?? '?'}
              {view.voiceToSuffix ? ` and go to the number ending ${view.voiceToSuffix}.` : '. No number to call is set.'}
            </span>
          ) : null}
        </div>
        <p className="m-0 text-text-secondary">{VOICE_COST_LINE}</p>
        <p className="m-0 text-small text-text-muted">
          NEXUS places the call, says the report and hangs up. It does not record, and it cannot take a command during the call: the answer to a call is a message. Calling NEXUS is not available yet.
        </p>
        {(() => {
          const problems = voiceTried ? voiceFormProblems(voice, voiceReady) : {}
          const field = (key: keyof VoiceForm, label: string, hint: string, secret = false): ReactNode => (
            <Field label={label} hint={hint} error={problems[key]}>
              {(id) => (
                <Input
                  id={id}
                  type={secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  value={voice[key]}
                  onChange={(e) => setVoice({ ...voice, [key]: e.target.value })}
                  data-testid={`director-line-voice-${key}`}
                />
              )}
            </Field>
          )
          const save = (): void => {
            setVoiceTried(true)
            if (Object.keys(voiceFormProblems(voice, voiceReady)).length > 0) return
            setProvider.mutate(voiceFormInput(voice), { onSuccess: () => { setVoice(EMPTY_VOICE_FORM); setVoiceTried(false); setAnnounce('Twilio is configured.') } })
          }
          return (
            <>
              {field('accountSid', 'Account SID', voiceReady ? 'Leave empty to keep the one stored.' : 'In the Twilio console, on the account dashboard.')}
              {field('apiKeySid', 'API key SID', voiceReady ? 'Leave empty to keep the one stored.' : 'Create an API key in the Twilio console (Account, API keys and tokens).')}
              {field('apiKeySecret', voiceReady ? 'API key secret (needed again to change anything)' : 'API key secret', 'Twilio shows it once, when the key is made. It is stored in protected storage and never shown again.', true)}
              {field('fromNumber', 'Twilio number', voiceReady ? 'Leave empty to keep the one stored.' : 'The number you have on Twilio, that calls come from. With + and the country code.')}
              {field('operatorNumber', 'Your phone number', voiceReady ? 'Leave empty to keep the one stored.' : 'The number NEXUS calls. With + and the country code. On a trial account it must be verified with Twilio first.')}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" loading={setProvider.isPending} disabled={voice.apiKeySecret.trim() === ''} onClick={save} data-testid="director-line-save-voice">
                  {voiceReady ? 'Save changes' : 'Save Twilio settings'}
                </Button>
                {voiceReady ? (
                  <Button variant="danger" busy={setProvider.isPending} onClick={() => setProvider.mutate({ kind: 'TWILIO_VOICE', secret: null }, { onSuccess: () => setAnnounce('Twilio settings removed. NEXUS will not call.') })}>
                    Remove Twilio
                  </Button>
                ) : null}
              </div>
            </>
          )
        })()}
      </Block>

      <Block title="Voice PIN">
        <p className="m-0 text-text-secondary" data-testid="director-line-pin-state">
          {view.pinConfigured ? 'A PIN is set.' : 'No PIN is set. Without one, nobody is authenticated on a call: an incoming call is ended, and a call NEXUS places only says its report.'}
        </p>
        <p className="m-0 text-small text-text-muted">
          A caller's number can be forged, so the number alone opens nothing. The PIN is asked on every incoming call, and before anything that changes work on a call NEXUS places. It is kept as a salted hash and never shown.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={view.pinConfigured ? 'New PIN' : 'PIN'} hint="6 to 12 digits.">
            {(id) => <Input id={id} type="password" inputMode="numeric" autoComplete="off" className="font-mono" value={pin} onChange={(e) => setPinText(e.target.value.replace(/\D/g, '').slice(0, 12))} data-testid="director-line-pin" />}
          </Field>
          <Field label="Again" error={pinAgain !== '' && pinAgain !== pin ? 'The two do not match.' : undefined}>
            {(id) => <Input id={id} type="password" inputMode="numeric" autoComplete="off" className="font-mono" value={pinAgain} onChange={(e) => setPinAgain(e.target.value.replace(/\D/g, '').slice(0, 12))} data-testid="director-line-pin-again" />}
          </Field>
          <Button
            variant="primary"
            loading={setPin.isPending}
            disabled={pin.length < 6 || pin !== pinAgain}
            onClick={() => setPin.mutate({ pin }, { onSuccess: () => { setPinText(''); setPinAgain(''); setAnnounce('The voice PIN is set.') } })}
            data-testid="director-line-save-pin"
          >
            {view.pinConfigured ? 'Change PIN' : 'Set PIN'}
          </Button>
        </div>
      </Block>

      <Block title="Report policy">
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 text-small text-text-secondary">Which events NEXUS reports, and for which it may also call.</legend>
          {EVENT_ORDER.map((kind) => {
            const rule = policy.events[kind]
            const words = THRESHOLD_WORDS[kind]
            return (
              <div key={kind} className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid={`director-line-event-${kind.toLowerCase()}`}>
                <div className="w-56">
                  <Checkbox checked={rule.enabled} label={EVENT_LABEL[kind]} onChange={(v) => edit((p) => { p.events[kind].enabled = v })} />
                </div>
                {words && rule.threshold !== undefined ? (
                  <span className="flex items-center gap-1.5 text-text-secondary">
                    {words.before}
                    <NumberField className="w-20" aria-label={`${EVENT_LABEL[kind]} threshold in ${words.unit === '%' ? 'percent' : 'minutes'}`} value={rule.threshold} min={0} max={100000} onChange={(v) => edit((p) => { p.events[kind].threshold = Math.round(v) })} />
                    {words.unit}
                  </span>
                ) : null}
                <Checkbox
                  checked={rule.call}
                  label="Call"
                  disabled={!rule.enabled || (!voiceReady && !rule.call)}
                  title={voiceReady ? undefined : 'Voice is not configured'}
                  onChange={(v) => edit((p) => { p.events[kind].call = v })}
                />
              </div>
            )
          })}
        </fieldset>
      </Block>

      <Block title="Quiet hours">
        <Toggle checked={policy.quietHours.enabled} onChange={(v) => edit((p) => { p.quietHours.enabled = v })} label="Hold non-critical reports during quiet hours" />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">
            {(id) => <Input id={id} type="time" className="w-32" disabled={!policy.quietHours.enabled} value={minuteToTime(policy.quietHours.startMinute)} onChange={(e) => { const m = timeToMinute(e.target.value); if (m !== null) edit((p) => { p.quietHours.startMinute = m }) }} />}
          </Field>
          <Field label="To">
            {(id) => <Input id={id} type="time" className="w-32" disabled={!policy.quietHours.enabled} value={minuteToTime(policy.quietHours.endMinute)} onChange={(e) => { const m = timeToMinute(e.target.value); if (m !== null) edit((p) => { p.quietHours.endMinute = m }) }} />}
          </Field>
          <Field label="Time zone" error={zoneOk ? undefined : 'Not a known time zone. An unknown zone is treated as quiet all day.'} hint={`This machine: ${view.machineTimeZone}`}>
            {(id) => <Input id={id} className="w-56" disabled={!policy.quietHours.enabled} value={policy.quietHours.timeZone} onChange={(e) => edit((p) => { p.quietHours.timeZone = e.target.value })} />}
          </Field>
        </div>
        <Checkbox checked={policy.quietHours.criticalBreaksQuiet} disabled={!policy.quietHours.enabled} label="Critical failures and security boundaries may break through quiet hours" onChange={(v) => edit((p) => { p.quietHours.criticalBreaksQuiet = v })} />
      </Block>

      <Block title="Fallback order">
        <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Order in which ways of reaching you are tried">
          {policy.precedence.map((cls, i) => (
            <li key={cls} className="flex items-center gap-2">
              <span className="w-6 text-text-muted">{i + 1}.</span>
              <span className="w-56">{CLASS_LABEL[cls]}</span>
              <Button size="sm" disabled={i === 0} aria-label={`Move ${CLASS_LABEL[cls]} earlier`} onClick={() => edit((p) => { p.precedence = moved(p.precedence, i, -1) })}>
                Earlier
              </Button>
              <Button size="sm" disabled={i === policy.precedence.length - 1} aria-label={`Move ${CLASS_LABEL[cls]} later`} onClick={() => edit((p) => { p.precedence = moved(p.precedence, i, 1) })}>
                Later
              </Button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            loading={setPolicy.isPending}
            disabled={!dirty || !zoneOk}
            onClick={() => draft && setPolicy.mutate({ policy: draft }, { onSuccess: () => { setDraft(null); setAnnounce('Report policy saved.') } })}
            data-testid="director-line-save-policy"
          >
            Save policy
          </Button>
          <Button disabled={!dirty} onClick={() => setDraft(null)}>
            Revert
          </Button>
          {dirty ? <span className="text-small text-text-secondary">Unsaved changes. Allowing calls or loosening quiet hours asks for confirmation on this PC.</span> : null}
        </div>
      </Block>

      <Block title="Last delivery">
        <p className="m-0 text-text-secondary" data-testid="director-line-last-delivery">
          {view.lastDelivery ? `${formatDateTime(view.lastDelivery.at)}: ${deliveryLine(view.lastDelivery.outcome)}${view.lastDelivery.errorClass ? ` (${view.lastDelivery.errorClass})` : ''}` : 'Nothing has been sent yet.'}
        </p>
      </Block>

      <Block title="Test">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            loading={testMessage.isPending}
            disabled={!paired}
            onClick={() => testMessage.mutate({}, { onSuccess: (r) => setAnnounce(r.ok ? 'Test message sent.' : `The test message was not sent (${r.errorClass ?? 'unknown'}).`) })}
            data-testid="director-line-test-message"
            aria-describedby={paired ? undefined : 'dl-test-why'}
          >
            Send test message
          </Button>
          <Button
            loading={testCall.isPending}
            disabled={view.voiceReason !== null}
            onClick={() => testCall.mutate({}, { onSuccess: (r) => setAnnounce(r.ok ? 'The test call was answered.' : `The test call did not connect (${r.errorClass ?? 'not answered'}).`) })}
            data-testid="director-line-test-call"
            aria-describedby={view.voiceReason ? 'dl-call-why' : undefined}
          >
            Test call
          </Button>
        </div>
        {!paired ? <p id="dl-test-why" className="m-0 text-small text-text-muted">Pair a phone to send a test message.</p> : null}
        {view.voiceReason ? <p id="dl-call-why" className="m-0 text-small text-text-muted" data-testid="director-line-call-why">Test call unavailable: {view.voiceReason}</p> : null}
        {working ? <span className="sr-only">Working</span> : null}
      </Block>
    </div>
  )
}
