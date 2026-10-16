#!/usr/bin/env node
// 0.9.1: fetches the models for local speech (src/main/modules/director-line/local-speech.ts) into
// vendor/speech-models/. Only the official k2-fsa/sherpa-onnx GitHub release assets are used; each archive is
// checked against the SHA-256 recorded here before it is unpacked, and a file that does not match is refused.
//
//   node scripts/fetch-speech-models.mjs                 download what is missing
//   node scripts/fetch-speech-models.mjs --from <dir>    take the archives from <dir> when they are there (no download)
//   node scripts/fetch-speech-models.mjs --dest <dir>    another target (default: vendor/speech-models)
//   node scripts/fetch-speech-models.mjs --force         unpack again even if the folder is complete
//
// The folder names below are the ones local-speech-models.ts expects.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dest = resolve(arg('--dest') ?? join(root, 'vendor', 'speech-models'))
const from = arg('--from') ? resolve(arg('--from')) : null
const force = args.includes('--force')

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'

/** kind 'archive' is a .tar.bz2 whose first folder is removed; 'file' is one file kept as it is. */
const ITEMS = [
  {
    name: 'silero_vad.onnx',
    kind: 'file',
    url: `${RELEASE}/asr-models/silero_vad.onnx`,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    target: 'silero_vad.onnx',
    marker: 'silero_vad.onnx',
  },
  {
    name: 'sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2',
    kind: 'archive',
    url: `${RELEASE}/asr-models/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2`,
    sha256: 'c8676e5ff9ac2a85296e53ee0fd4d5fb1db6770e7a7647166eeafe349ade6834',
    target: 'stt-kroko-en',
    marker: 'stt-kroko-en/joiner.onnx',
  },
  {
    name: 'sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06.tar.bz2',
    kind: 'archive',
    url: `${RELEASE}/asr-models/sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06.tar.bz2`,
    sha256: 'e6ffd3dc43725cd6c8137b05c739f15607d0df946b9b90eb141e10059efca024',
    target: 'stt-kroko-fr',
    marker: 'stt-kroko-fr/joiner.onnx',
  },
  {
    name: 'vits-piper-en_US-ljspeech-medium-int8.tar.bz2',
    kind: 'archive',
    url: `${RELEASE}/tts-models/vits-piper-en_US-ljspeech-medium-int8.tar.bz2`,
    sha256: '24dc3bd77dd48c291e52c297878d3437c9492f245d823d7f6a06c4bbb67f4b6b',
    target: 'tts-piper-en_US-ljspeech-medium',
    marker: 'tts-piper-en_US-ljspeech-medium/en_US-ljspeech-medium.onnx',
  },
  {
    name: 'vits-piper-fr_FR-siwis-medium-int8.tar.bz2',
    kind: 'archive',
    url: `${RELEASE}/tts-models/vits-piper-fr_FR-siwis-medium-int8.tar.bz2`,
    sha256: '3909cff9b3cfd4820c66aa13bf554315c82e34899c161f0b446ece372bc4b5ec',
    target: 'tts-piper-fr_FR-siwis-medium',
    marker: 'tts-piper-fr_FR-siwis-medium/fr_FR-siwis-medium.onnx',
  },
]

// What each model's own card says, read from the cards inside the archives (and, for Kroko, the page that its
// README points to). Written to NOTICE.txt next to the models.
const NOTICE = `NEXUS local speech: models in this folder
=========================================

These files are downloaded by scripts/fetch-speech-models.mjs and are not part of the NEXUS source. Each model
keeps its own licence. What is stated below is what the model's own card says; where a licence is unclear that
is said here, not hidden.

1. silero_vad.onnx  (voice activity detection)
   Source:  ${RELEASE}/asr-models/silero_vad.onnx
   Origin:  Silero VAD, https://github.com/snakers4/silero-vad
   Licence: MIT, as stated by the Silero VAD project. (Not re-read from the project page when this file was
            written: check it before shipping.)

2. stt-kroko-en/  and  3. stt-kroko-fr/  (streaming speech recognition, English and French)
   Source:  ${RELEASE}/asr-models/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2
            ${RELEASE}/asr-models/sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06.tar.bz2
   Origin:  Banafo "Kroko ASR", https://huggingface.co/Banafo/Kroko-ASR
   Licence: UNCLEAR. The README inside each archive says only "See license at
            https://huggingface.co/Banafo/Kroko-ASR". That page's metadata reads "license: other,
            license_name: test, license_link: LICENSE" (no licence text was found there), while its text says
            Kroko has "community models" under CC-BY-SA (free, open source) and separate commercial/OEM models
            under a commercial licence. Nothing in the archives says which of the two these files are. Treat
            them as CC-BY-SA community models at most (attribution and share-alike apply to the model files) and
            ask Banafo (https://kroko.ai/) in writing before shipping NEXUS to anyone else. A replacement with a
            clear licence (for instance the icefall streaming zipformer models on the same release page, which are believed
            to be Apache-2.0; not checked) would need only the folder names in local-speech-models.ts and a new check of the
            quality; it has not been tested here.

4. tts-piper-en_US-ljspeech-medium/  (English voice)
   Source:  ${RELEASE}/tts-models/vits-piper-en_US-ljspeech-medium-int8.tar.bz2
   Origin:  Piper voice trained by Bryce Beattie on the LJ Speech dataset, https://keithito.com/LJ-Speech-Dataset/
   Licence: public domain (model card: "License: public domain"). Chosen over the "lessac" voice, whose card
            points to the Blizzard 2013 licence at https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html
            (a licence agreement for research use, not a free licence).

5. tts-piper-fr_FR-siwis-medium/  (French voice)
   Source:  ${RELEASE}/tts-models/vits-piper-fr_FR-siwis-medium-int8.tar.bz2
   Origin:  Piper voice trained on the SIWIS French Speech Synthesis Database, https://datashare.is.ed.ac.uk/handle/10283/2353
            (fine-tuned from the "lessac" English voice: the card says "Finetuned from U.S. English lessac voice")
   Licence: CC-BY 4.0 (model card: "License: CC-BY 4.0"). Attribution: SIWIS database, University of Edinburgh
            (Honnet, Lazaridis, Garner, Yamagishi). The note above about the English "lessac" voice's own
            licence also touches this model, because it was fine-tuned from it; the card does not say whether
            that matters.

Both voices ship an espeak-ng-data folder. espeak-ng is licensed GPL-3.0; the sherpa-onnx library uses it to turn
text into phonemes.

The native library that runs all of them, sherpa-onnx (npm package sherpa-onnx-node), is Apache-2.0.
`

function log(line) {
  console.log(line)
}

async function sha256(file) {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

async function download(url, file) {
  const res = await globalThis.fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download of ${url} failed: HTTP ${res.status}`)
  const part = `${file}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  renameSync(part, file)
}

function untar(archive, target) {
  mkdirSync(target, { recursive: true })
  const cwd = dirname(archive)
  const r = spawnSync('tar', ['-xjf', basename(archive), '--strip-components=1', '-C', relative(cwd, target).split(sep).join('/')], { cwd, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`could not unpack ${archive} (is tar with bzip2 support on the PATH?)`)
}

mkdirSync(dest, { recursive: true })
const cache = join(dest, '.download')
let failures = 0
for (const item of ITEMS) {
  if (!force && existsSync(join(dest, item.marker)) && statSync(join(dest, item.marker)).size > 0) {
    log(`present   ${item.target}`)
    continue
  }
  let file = from ? join(from, item.name) : null
  if (file === null || !existsSync(file)) {
    if (from) log(`not in ${from}: ${item.name}`)
    mkdirSync(cache, { recursive: true })
    file = join(cache, item.name)
    if (!existsSync(file)) {
      log(`download  ${item.url}`)
      await download(item.url, file)
    }
  }
  const got = await sha256(file)
  if (got !== item.sha256) {
    log(`REFUSED   ${item.name}: SHA-256 is ${got}, expected ${item.sha256}`)
    failures += 1
    continue
  }
  const target = join(dest, item.target)
  if (item.kind === 'file') {
    copyFileSync(file, target)
  } else {
    rmSync(target, { recursive: true, force: true })
    untar(file, target)
    rmSync(join(target, 'test_wavs'), { recursive: true, force: true })
  }
  log(`ready     ${item.target}`)
}
writeFileSync(join(dest, 'NOTICE.txt'), NOTICE)
if (existsSync(cache)) rmSync(cache, { recursive: true, force: true })
if (failures > 0) {
  console.error(`${failures} archive(s) refused`)
  process.exit(1)
}
log(`done: ${dest}`)
