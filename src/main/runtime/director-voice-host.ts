import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { AgentRuntime } from '../modules/agent-runtime/types'
import { DirectorVoice } from '../modules/director-line/director-voice'
import { LinphoneSipProvider } from '../modules/director-line/linphone-sip-provider'
import { LocalSpeech } from '../modules/director-line/local-speech'
import type { VoiceHost } from '../modules/director-line/voice-config'
import type { SpeechToTextProvider, TextToSpeechProvider, TurnDetectionProvider } from '../modules/director-line/voice-provider'

/**
 * 0.9.1: what the application gives the Director's voice line: the SIP helper with the Linphone libraries, the
 * speech engines, and a model session for the words of an answer.
 *
 * The SIP helper is a program of its own. It is started with the folder of its libraries and a folder to write
 * in, and with nothing of NEXUS's environment: it has no path to a project, to the database or to a provider's
 * credentials. The model session of a call is not one of the worker sessions: it has no tools, it is started
 * for the call and ended with it, and it takes no slot from the work in progress, so a call is answered while
 * every worker is busy. It is still held back while the account must not be used.
 */

export interface VoiceSpeech {
  stt: SpeechToTextProvider
  tts: TextToSpeechProvider
  turns: TurnDetectionProvider | null
}

/** Electron cannot load a native module or start a worker from inside app.asar: the unpacked copy is used. */
const unpacked = (path: string): string => path.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked')

export interface LocalVoiceSpeech {
  speech: VoiceSpeech | null
  /** Why there is none. */
  reason: string | null
  /** Loads the models (some seconds, some hundred megabytes), so that the first call does not wait for them. */
  warm(): Promise<void>
  /** Names that are written as they are spelled when they are heard: the projects. */
  setHints(names: readonly string[]): void
  dispose(): Promise<void>
}

/**
 * Speech recognition and synthesis on this PC (sherpa-onnx with the models of scripts/fetch-speech-models.mjs):
 * no sound of a call leaves the machine for them. Nothing is loaded until `warm` or the first call.
 */
export function createLocalVoiceSpeech(deps: { launcherPath: string | undefined; resourcesPath: string | undefined; languages: string[]; log: (line: string) => void }): LocalVoiceSpeech {
  const none = (reason: string): LocalVoiceSpeech => ({ speech: null, reason, warm: async () => undefined, setHints: () => undefined, dispose: async () => undefined })
  const modelsDir = deps.resourcesPath !== undefined ? join(deps.resourcesPath, 'speech-models') : deps.launcherPath !== undefined ? resolve(dirname(deps.launcherPath), '..', '..', 'vendor', 'speech-models') : null
  if (modelsDir === null || !LocalSpeech.check(modelsDir).ok) return none('The speech models are not part of this build.')
  let sherpa: string
  try {
    sherpa = unpacked(createRequire(import.meta.url).resolve('sherpa-onnx-node'))
  } catch {
    return none('The speech engine is not part of this build.')
  }
  const workerPath = unpacked(join(import.meta.dirname, 'speech-worker.js'))
  if (!existsSync(workerPath)) return none('The speech worker is not part of this build.')
  try {
    const local = LocalSpeech.create({ sherpa, modelsDir, threads: 4, workerPath, log: deps.log })
    local.tts.setLanguages(deps.languages)
    return {
      speech: { stt: local.stt, tts: local.tts, turns: null },
      reason: null,
      warm: () => local.warm(),
      setHints: (names) => local.setHints(names),
      dispose: () => local.dispose(),
    }
  } catch {
    return none('The speech engine could not be prepared.')
  }
}

export interface DirectorVoiceHostDeps {
  /** The launcher's path: the other native helpers are next to it. */
  launcherPath: string | undefined
  /** Electron's resources folder in a packaged application. */
  resourcesPath: string | undefined
  dataDir: string
  runtime: Pick<AgentRuntime, 'startSession'>
  /** The fast tier, read at each call. Empty: the runtime's default. */
  model: () => string
  subscriptionMode: () => boolean
  admitted: () => boolean
  /** The status as NEXUS gives it, for a question outside the commands. */
  status: () => Promise<string>
  /** Null: no speech engine is installed, so no call can be held. */
  speech: VoiceSpeech | null
  /** A call begins. */
  onCall?: () => void
  log: (line: string) => void
}

export function createDirectorVoiceHost(deps: DirectorVoiceHostDeps): VoiceHost {
  const helperPath = deps.launcherPath !== undefined ? join(dirname(deps.launcherPath), 'nexus-sip.exe') : null
  // Packaged: resources/linphone. From the source tree: vendor/linphone-sdk/win64 (the helpers are in out/native).
  const runtimeDir = deps.resourcesPath !== undefined ? join(deps.resourcesPath, 'linphone') : helperPath !== null ? resolve(dirname(helperPath), '..', '..', 'vendor', 'linphone-sdk', 'win64') : null
  let unavailableReason: string | null = null
  if (process.platform !== 'win32') unavailableReason = 'The SIP helper is a Windows program.'
  else if (helperPath === null || !existsSync(helperPath)) unavailableReason = 'The SIP helper is not part of this build.'
  else if (runtimeDir === null || !existsSync(join(runtimeDir, 'liblinphone.dll'))) unavailableReason = 'The Linphone libraries are not part of this build.'

  const cwd = join(deps.dataDir, 'director-line', 'voice-session')
  return {
    available: unavailableReason === null,
    ...(unavailableReason !== null ? { unavailableReason } : {}),
    create: (account) => {
      const provider = new LinphoneSipProvider({
        helperPath: helperPath as string,
        runtimeDir: runtimeDir as string,
        stateDir: join(deps.dataDir, 'director-line', 'sip'),
        account,
        log: deps.log,
      })
      return { provider, networkChanged: () => provider.networkChanged() }
    },
    stt: deps.speech?.stt ?? null,
    tts: deps.speech?.tts ?? null,
    turns: deps.speech?.turns ?? null,
    directorVoice: () => {
      deps.onCall?.()
      if (!deps.admitted()) return null
      // An empty folder of its own: the session has no tools, and nothing of a project is under it.
      mkdirSync(cwd, { recursive: true })
      const model = deps.model()
      return new DirectorVoice({
        runtime: deps.runtime,
        cwd,
        ...(model !== '' ? { model } : {}),
        subscriptionMode: deps.subscriptionMode(),
        admitted: deps.admitted,
        onTurn: (turn) => deps.log(`voice turn: ${turn.outcome}, first word ${turn.firstWordMs ?? '-'} ms, ${turn.totalMs} ms`),
      })
    },
    generalFacts: deps.status,
  }
}
