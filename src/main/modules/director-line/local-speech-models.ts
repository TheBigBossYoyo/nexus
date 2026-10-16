import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SpeechLanguage } from './local-speech-text'

/**
 * 0.9.1, local speech: where the models are. `scripts/fetch-speech-models.mjs` puts each archive in the folder
 * named here (inside `vendor/speech-models/`, the first folder of the archive removed), and this file is the one
 * place that knows the names.
 */

export const VAD_MODEL = 'silero_vad.onnx'

export const STT_MODELS: Record<SpeechLanguage, { dir: string; files: string[] }> = {
  en: { dir: 'stt-kroko-en', files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'] },
  fr: { dir: 'stt-kroko-fr', files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'] },
}

export interface TtsVoiceFiles {
  dir: string
  model: string
  speakerId: number
}

export const TTS_VOICES: Record<SpeechLanguage, TtsVoiceFiles> = {
  en: { dir: 'tts-piper-en_US-ljspeech-medium', model: 'en_US-ljspeech-medium.onnx', speakerId: 0 },
  fr: { dir: 'tts-piper-fr_FR-siwis-medium', model: 'fr_FR-siwis-medium.onnx', speakerId: 0 },
}

function present(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0
  } catch {
    return false
  }
}

/** Every file that a set of languages needs and the folder lacks, as paths relative to it. */
export function missingModelFiles(modelsDir: string, languages: readonly SpeechLanguage[] = ['en', 'fr'], parts: { stt?: boolean; tts?: boolean } = {}): string[] {
  const missing: string[] = []
  const need = (rel: string): void => {
    if (!present(join(modelsDir, rel))) missing.push(rel.replace(/\\/g, '/'))
  }
  if (parts.stt !== false) {
    need(VAD_MODEL)
    for (const l of languages) for (const f of STT_MODELS[l].files) need(`${STT_MODELS[l].dir}/${f}`)
  }
  if (parts.tts !== false) {
    for (const l of languages) {
      const v = TTS_VOICES[l]
      need(`${v.dir}/${v.model}`)
      need(`${v.dir}/tokens.txt`)
      need(`${v.dir}/espeak-ng-data/phontab`)
    }
  }
  return missing
}
