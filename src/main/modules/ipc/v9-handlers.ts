import { normalizeSipIdentity, type CommunicationPolicy } from '@shared/director-line'
import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import { NexusError } from '@shared/result'
import type { DirectorLineRuntime } from '@main/modules/director-line/runtime'

type DirectorLineChannel = Extract<IpcChannel, `directorLine.${string}`>
export type DirectorLineHandlers = { [C in DirectorLineChannel]: (input: IpcInput<C>) => IpcOutputs[C] | Promise<IpcOutputs[C]> }

/** The part of the runtime the handlers use. */
export type DirectorLineControl = Pick<
  DirectorLineRuntime,
  'settingsView' | 'setEnabled' | 'setProvider' | 'setPolicy' | 'startPairing' | 'setPin' | 'unpair' | 'sendTestMessage' | 'setSip' | 'removeSip' | 'setVoicePolicy' | 'callMe' | 'hangUpCall' | 'confirmCallSas'
>

export interface DirectorLineHandlerContext {
  directorLine: DirectorLineControl
  /**
   * A native confirmation shown by the runtime process itself, before anything that opens a channel to the outside,
   * gives a phone authority or spends money. A client of the pipe cannot answer it. No way to ask is a no.
   */
  confirm?: (title: string, message: string, detail: string, accept: string) => Promise<boolean>
}

const WHAT_A_PHONE_CAN_DO = [
  'The paired chat will be able to:',
  '  • ask for status, time remaining, blockers, details of a project and the latest test results;',
  '  • pause missions after the current task, and resume them;',
  '  • add tasks, which go through the same checks as a task you type here;',
  '  • ask NEXUS to call them, and talk to it on a call.',
  '',
  'It can never:',
  '  • grant or approve a boundary request (that needs the confirmation on this PC);',
  '  • push, publish or deploy;',
  '  • change settings, the sandbox or the autonomy profile;',
  '  • delete anything, run a command, or touch power.',
].join('\n')

const ENCRYPTION_WORDS = {
  none: 'none (the voice is sent in the clear)',
  srtp: 'SRTP (the keys are known to the SIP server)',
  zrtp: 'ZRTP (keys agreed between the two telephones; compare the verification code to be sure)',
  dtls: 'DTLS-SRTP (its fingerprints travel through the SIP server)',
} as const

const REFUSED = 'Nothing was changed: the confirmation was declined or could not be shown.'

/** What the new policy allows that the current one did not. Only a widening needs a question. */
export function policyWidens(current: CommunicationPolicy, next: CommunicationPolicy): string[] {
  const reasons: string[] = []
  for (const kind of Object.keys(next.events) as (keyof CommunicationPolicy['events'])[]) {
    if (next.events[kind].enabled && next.events[kind].call && !(current.events[kind].enabled && current.events[kind].call)) reasons.push('phone calls (which cost money) for more events')
  }
  if (current.quietHours.enabled && !next.quietHours.enabled) reasons.push('no quiet hours: NEXUS may message or call at any hour')
  if (!current.quietHours.criticalBreaksQuiet && next.quietHours.criticalBreaksQuiet) reasons.push('critical reports break through quiet hours')
  if (current.requirePinForStatus && !next.requirePinForStatus) reasons.push('a phone call may read status without the PIN')
  return [...new Set(reasons)]
}

/**
 * 0.9 Director Line channels. None is reachable from an agent session. Those that open a channel to the outside,
 * give a phone authority or spend money are confirmed natively; unpairing and the test message only remove
 * authority or send one fixed line, and are not. No output carries a token, a PIN, or (except the one-time result
 * of startPairing) a pairing code.
 */
export function createDirectorLineHandlers(ctx: DirectorLineHandlerContext): DirectorLineHandlers {
  const { directorLine } = ctx
  // No way to ask is a no.
  const mustConfirm = async (title: string, message: string, detail: string, accept: string): Promise<void> => {
    if (ctx.confirm === undefined || !(await ctx.confirm(title, message, detail, accept))) throw new NexusError('invalid_state', REFUSED)
  }

  return {
    'directorLine.get': () => directorLine.settingsView(),

    'directorLine.setEnabled': async ({ enabled }) => {
      if (enabled && !(await directorLine.settingsView()).enabled) {
        await mustConfirm(
          'Turn on the Director Line',
          'Let NEXUS talk to you through your phone?',
          ['NEXUS will contact the message service you configured (Telegram) over the Internet, and listen for messages from the one chat you pair.', '', WHAT_A_PHONE_CAN_DO].join('\n'),
          'Turn on',
        )
      }
      await directorLine.setEnabled(enabled)
      return directorLine.settingsView()
    },

    'directorLine.setProvider': async (input) => {
      const detail =
        input.secret === null
          ? 'The stored credentials of the Telegram bot will be removed.'
          : ['The bot token is stored in protected storage and never shown again. NEXUS will use it to talk to api.telegram.org on your behalf.', 'Anyone who holds the token controls the bot: keep it private.'].join('\n')
      await mustConfirm(
        input.secret === null ? 'Remove a provider' : 'Set a provider',
        input.secret === null ? 'Remove the Telegram bot?' : 'Use this Telegram bot for the Director Line?',
        detail,
        input.secret === null ? 'Remove' : 'Use',
      )
      await directorLine.setProvider(input)
      return directorLine.settingsView()
    },

    'directorLine.setPolicy': async ({ policy }) => {
      const widened = policyWidens((await directorLine.settingsView()).policy, policy as CommunicationPolicy)
      if (widened.length > 0) {
        await mustConfirm('Change what NEXUS may do on its own', 'Change the reporting policy?', ['This change allows:', ...widened.map((w) => `  • ${w}`)].join('\n'), 'Change')
      }
      await directorLine.setPolicy(policy as CommunicationPolicy)
      return directorLine.settingsView()
    },

    'directorLine.startPairing': async ({ channel }) => {
      // The state is checked before the question: there is no point asking for something that cannot happen.
      const view = await directorLine.settingsView()
      if (!view.enabled || !view.messageProvider.configured) throw new NexusError('invalid_state', 'Turn the Director Line on and store a bot token before pairing.')
      await mustConfirm(
        'Pair a phone',
        'Show a pairing code?',
        ['Whoever sends the code to your bot within 10 minutes becomes the paired operator. Show it only to yourself.', '', WHAT_A_PHONE_CAN_DO].join('\n'),
        'Show the code',
      )
      return directorLine.startPairing(channel)
    },

    'directorLine.setPin': async ({ pin }) => {
      await mustConfirm(
        'Set the phone PIN',
        'Set a PIN for calls?',
        'The PIN lets a caller from the paired number ask for status by phone. It is kept only as a salted hash, and three wrong tries lock it for 30 minutes. A phone number alone never gives access.',
        'Set PIN',
      )
      await directorLine.setPin(pin)
      return { configured: true }
    },

    'directorLine.unpair': async ({ channel }) => ({ removed: await directorLine.unpair(channel) }),

    'directorLine.sendTestMessage': () => directorLine.sendTestMessage(),

    'directorLine.setSip': async (input) => {
      await mustConfirm(
        'Set up the voice line',
        'Let NEXUS use this SIP account, and answer this phone?',
        [
          `NEXUS will register as ${normalizeSipIdentity(input.identity) ?? input.identity} with its SIP server over the Internet, and keep the password in protected storage, never shown again.`,
          '',
          `Encryption of the voice: ${ENCRYPTION_WORDS[input.mediaEncryption]}. ${input.mediaEncryptionMandatory ? 'Calls whose voice is not encrypted are refused.' : 'Calls whose voice is not encrypted are NOT refused: such a call opens by saying it is not encrypted.'}`,
          input.stunServer === null ? 'No STUN server is used.' : `The STUN server ${input.stunServer} will be asked for this PC's public address.`,
          '',
          `The one SIP address ${normalizeSipIdentity(input.operatorIdentity) ?? input.operatorIdentity} will be able to call NEXUS, and NEXUS will call it. On a call it can do what the paired chat can do, after the PIN.`,
          '',
          WHAT_A_PHONE_CAN_DO,
        ].join('\n'),
        'Set up',
      )
      await directorLine.setSip(input)
      return directorLine.settingsView()
    },

    'directorLine.removeSip': async () => {
      await mustConfirm('Remove the voice line', 'Remove the SIP account of NEXUS?', 'The stored password is deleted and the phone address is unpaired. Calls stop at once.', 'Remove')
      await directorLine.removeSip()
      return directorLine.settingsView()
    },

    'directorLine.setVoicePolicy': async (policy) => {
      const current = (await directorLine.settingsView()).voice.policy
      // Only a widening is asked about: the address alone opening the line, more calls a day, calls closer together.
      if (current.requirePin && !policy.requirePin) {
        await mustConfirm(
          'Change what a call may do',
          'Stop asking for the PIN on calls?',
          [
            'A call that comes through the SIP server NEXUS is registered with, from the paired address, will then be trusted without a PIN.',
            'The server decides whose call that is: anyone who can sign in to that server as the paired address, or who controls the server, will be able to do what the phone can do here (status, pause and resume, add tasks) and NEXUS cannot tell them from you.',
            'A call that did not come through the server, or whose voice is not encrypted, still needs the PIN.',
          ].join('\n\n'),
          'Change',
        )
      } else if ((policy.maxPlacedCallsPerDay > 6 && policy.maxPlacedCallsPerDay > current.maxPlacedCallsPerDay) || (policy.minMinutesBetweenPlacedCalls < 10 && policy.minMinutesBetweenPlacedCalls < current.minMinutesBetweenPlacedCalls)) {
        await mustConfirm(
          'Change how often NEXUS calls',
          'Let NEXUS ring more often?',
          `NEXUS may ring your phone up to ${policy.maxPlacedCallsPerDay} times a day, at least ${policy.minMinutesBetweenPlacedCalls} minutes apart. Each ring that is not answered is followed by a message.`,
          'Change',
        )
      }
      await directorLine.setVoicePolicy(policy)
      return directorLine.settingsView()
    },

    'directorLine.callMe': async () => ({ result: await directorLine.callMe() }),

    'directorLine.hangUpCall': async () => {
      await directorLine.hangUpCall()
      return directorLine.settingsView()
    },

    'directorLine.confirmCallSas': async () => {
      // The code is read here, by the runtime, and shown in the confirmation: it is not something the screen sends.
      const sas = (await directorLine.settingsView()).voice.callSecurity?.sas ?? null
      if (sas === null) throw new NexusError('invalid_state', 'There is no call with a ZRTP verification code to confirm.')
      await mustConfirm(
        'Verify the call',
        'The telephone shows the same four characters?',
        `The code on this PC is ${sas}.

Open the call screen of Linphone on the telephone and read the code it shows. Confirm only if the four characters are the same. If they differ, hang up: someone may be between the two ends.`,
        'They match',
      )
      // Applied only if that code is still the one of the call in progress.
      if (!(await directorLine.confirmCallSas(sas))) throw new NexusError('invalid_state', 'The call changed while the question was open. Nothing was verified.')
      return directorLine.settingsView()
    },
  }
}
