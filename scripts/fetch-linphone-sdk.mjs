// Obtains the runtime the SIP helper (native/nexus-sip) needs: the 64-bit DLLs of the official Linphone SDK, its
// grammars and root certificates, and its licence texts, in vendor/linphone-sdk/win64/.
//
//   node scripts/fetch-linphone-sdk.mjs                    downloads the SDK (about 300 MB), checks it, unpacks the runtime
//   node scripts/fetch-linphone-sdk.mjs --zip <path>       uses a copy already on disk
//   node scripts/fetch-linphone-sdk.mjs --out <dir>        another destination (default vendor/linphone-sdk/win64)
//   node scripts/fetch-linphone-sdk.mjs --force            unpacks again even when the runtime is there
//
// The archive is refused unless its SHA-256 is the one below. Only the files named here are taken out of it, by
// exact name; nothing else in the archive is read or written, so no path inside it can place a file elsewhere.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32, inflateRawSync } from 'node:zlib'

const here = resolve(import.meta.dirname, '..')

export const SDK_VERSION = '5.5.32'
export const SDK_FILE = `linphone-sdk-win64-${SDK_VERSION}.zip`
export const SDK_URL = `https://download.linphone.org/releases/windows/sdk/${SDK_FILE}`
export const SDK_SHA256 = '71b6203ff74f0f3949cdf67871e7a8c309898d13d3418e94922ea65704ae83b1'
export const SOURCE_URL = `https://gitlab.linphone.org/BC/public/linphone-sdk/-/tags/${SDK_VERSION}`
export const SOURCE_ARCHIVE = `https://gitlab.linphone.org/BC/public/linphone-sdk/-/archive/${SDK_VERSION}/linphone-sdk-${SDK_VERSION}.tar.gz`

const ROOT = 'linphone-sdk/win64/'

/** The 31 libraries the helper loads (directly or as dependencies of liblinphone), flat in the runtime folder. */
export const RUNTIME_DLLS = [
  'ZXing', 'bctoolbox', 'belcard', 'belle-sip', 'belr', 'bv16', 'bzrtp', 'decaf', 'gsm', 'hidapi', 'jpeg62', 'jsoncpp',
  'liblinphone', 'lime', 'mbedcrypto', 'mbedtls', 'mbedx509', 'mediastreamer2', 'opus', 'ortp', 'soci_core_4_0',
  'soci_sqlite3_4_0', 'speex', 'speexdsp', 'sqlite3', 'srtp2', 'turbojpeg', 'xerces-c', 'xml2', 'yuv', 'zlib1',
].map((n) => `${n}.dll`)

const GRAMMARS = [
  'belr-grammar-example.blr', 'cpim_grammar.belr', 'ics_grammar.belr', 'identity_grammar.belr', 'mwi_grammar.belr',
  'sdp_grammar.belr', 'sip_grammar.belr', 'vcard3_grammar.belr', 'vcard_grammar.belr',
]

/** archive name (under linphone-sdk/win64/) -> destination (under the output folder) */
export function wantedFiles() {
  const map = new Map()
  for (const dll of RUNTIME_DLLS) map.set(`bin/${dll}`, dll)
  for (const g of GRAMMARS) map.set(`share/belr/grammars/${g}`, `share/belr/grammars/${g}`)
  map.set('share/linphone/rootca.pem', 'share/linphone/rootca.pem')
  map.set('share/doc/ortp-5.5.0/LICENSE.txt', 'licenses/AGPL-3.0.txt')
  map.set('share/doc/ortp-5.5.0/AUTHORS.md', 'licenses/ortp-AUTHORS.md')
  map.set('share/doc/linphone-sdk/LICENSE.md', 'licenses/libjpeg-turbo-LICENSE.md')
  map.set('share/doc/linphone-sdk/README.ijg', 'licenses/libjpeg-turbo-README.ijg')
  map.set('share/doc/mediastreamer2-5.5.0/html/mediastreamer2_license.html', 'licenses/mediastreamer2_license.html')
  return map
}

export function noticeText(dllNames = RUNTIME_DLLS) {
  return `NEXUS ships a runtime taken, unmodified, from the Linphone SDK.

Component   Linphone SDK for Windows (64-bit): liblinphone ${SDK_VERSION} and the libraries it is built with
Version     ${SDK_VERSION}
Obtained    ${SDK_URL}
            SHA-256 ${SDK_SHA256}
By          Belledonne Communications SARL (https://www.linphone.org)

Licence     GNU Affero General Public License, version 3 or later, for liblinphone, mediastreamer2 and oRTP (the
            licence notice in their headers, and share/doc/ortp-5.5.0/LICENSE.txt of the SDK, kept here as
            licenses/AGPL-3.0.txt). belle-sip, bzrtp and bctoolbox carry the GNU General Public License,
            version 3 or later, in their headers. The SDK also bundles libraries under their own licences (for
            example libjpeg-turbo, whose notices are in licenses/; Opus, mbed TLS, libsrtp, SQLite, zlib, libxml2,
            Xerces-C++, Speex, GSM, BV16, ZXing, jsoncpp, SOCI, decaf, hidapi, libyuv); each is covered by its own
            terms, which the SDK's source tree states. This notice does not replace any of them.

Source      The complete corresponding source of exactly this version is published by Belledonne Communications:
              ${SOURCE_URL}
              ${SOURCE_ARCHIVE}
            (the repository linphone-sdk at tag ${SDK_VERSION}, with its git submodules: liblinphone, mediastreamer2,
            ortp, belle-sip, bzrtp, bctoolbox, belr, belcard, lime and the third-party libraries). The tag and the
            archive were found to exist on 2026-10-13. Whoever redistributes NEXUS with this runtime must offer
            that source, or this notice and these addresses, to the people who receive it.

What is here  ${dllNames.length} libraries (*.dll), share/belr/grammars/ and share/linphone/rootca.pem (both read by
              liblinphone at run time), and licenses/. Nothing else from the SDK: no headers, no tester programs,
              no wrapper, no documentation.

Used by     native/nexus-sip/nexus-sip.cs (nexus-sip.exe), which loads these libraries from this folder.
`
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolveHash(hash.digest('hex')))
  })
}

/** Reads the central directory of a (non-ZIP64) archive: name -> { method, csize, size, crc, offset }. */
function readDirectory(fd, total) {
  const tailLen = Math.min(total, 65557)
  const tail = Buffer.alloc(tailLen)
  readSync(fd, tail, 0, tailLen, total - tailLen)
  let eocd = -1
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('This is not a zip archive.')
  const count = tail.readUInt16LE(eocd + 10)
  const dirSize = tail.readUInt32LE(eocd + 12)
  const dirOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new Error('A ZIP64 archive is not supported by this script.')
  const dir = Buffer.alloc(dirSize)
  readSync(fd, dir, 0, dirSize, dirOffset)
  const entries = new Map()
  let p = 0
  for (let n = 0; n < count; n++) {
    if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip directory is damaged.')
    const method = dir.readUInt16LE(p + 10)
    const crc = dir.readUInt32LE(p + 16)
    const csize = dir.readUInt32LE(p + 20)
    const size = dir.readUInt32LE(p + 24)
    const nameLen = dir.readUInt16LE(p + 28)
    const extraLen = dir.readUInt16LE(p + 30)
    const commentLen = dir.readUInt16LE(p + 32)
    const offset = dir.readUInt32LE(p + 42)
    const name = dir.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, { method, crc, csize, size, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readEntry(fd, e, name) {
  const head = Buffer.alloc(30)
  readSync(fd, head, 0, 30, e.offset)
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${name}: damaged local header`)
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  const raw = Buffer.alloc(e.csize)
  readSync(fd, raw, 0, e.csize, start)
  const data = e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw) : null
  if (data === null) throw new Error(`${name}: unsupported compression ${e.method}`)
  if (data.length !== e.size) throw new Error(`${name}: wrong size`)
  if (crc32(data) !== e.crc) throw new Error(`${name}: checksum mismatch`)
  return data
}

async function download(url, to) {
  const response = await globalThis.fetch(url)
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} for ${url}`)
  mkdirSync(dirname(to), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to))
}

/** Unpacks the runtime into `out`. Returns { out, files }. */
export async function fetchLinphoneSdk({ zip, out = join(here, 'vendor', 'linphone-sdk', 'win64'), force = false, log = console.log } = {}) {
  const marker = join(out, 'NOTICE.txt')
  if (!force && existsSync(marker) && existsSync(join(out, 'liblinphone.dll'))) {
    log(`The Linphone runtime is already in ${out}.`)
    return { out, files: 0 }
  }
  let archive = zip ? resolve(zip) : null
  let downloaded = false
  if (archive === null) {
    archive = join(here, 'out', 'linphone-sdk-download', SDK_FILE)
    log(`Downloading ${SDK_URL} ...`)
    await download(SDK_URL, archive)
    downloaded = true
  }
  try {
    log(`Checking ${archive} ...`)
    const sum = await sha256File(archive)
    if (sum !== SDK_SHA256) throw new Error(`Refused: the archive's SHA-256 is ${sum}, expected ${SDK_SHA256}.`)
    const total = statSync(archive).size
    const fd = openSync(archive, 'r')
    let written = 0
    try {
      const entries = readDirectory(fd, total)
      mkdirSync(out, { recursive: true })
      for (const [inside, dest] of wantedFiles()) {
        const entry = entries.get(ROOT + inside)
        if (!entry) throw new Error(`The archive does not contain ${ROOT + inside}.`)
        const target = join(out, ...dest.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, readEntry(fd, entry, inside))
        written++
      }
    } finally {
      closeSync(fd)
    }
    writeFileSync(join(out, 'NOTICE.txt'), noticeText())
    log(`${written} files written to ${out}.`)
    return { out, files: written }
  } finally {
    if (downloaded) rmSync(dirname(archive), { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  fetchLinphoneSdk({ zip: value('--zip'), out: value('--out') ? resolve(value('--out')) : undefined, force: args.includes('--force') }).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
