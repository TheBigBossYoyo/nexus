import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 0.8: where a file fetched from the public web is put. A directory of NEXUS's own, outside every worktree,
 * under a name NEXUS chose that says nothing of what the file is and has no extension Windows would run. What
 * the file is, is read from its first bytes, not from its name or the type the server declared. A program, a
 * script, an installer or a shortcut is refused and not kept. Nothing here runs anything, and nothing that
 * arrives here becomes project input by arriving.
 */

export type SniffedKind = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'zip' | 'gzip' | 'tar' | 'sevenzip' | 'text' | 'json' | 'xml' | 'windows-executable' | 'elf-executable' | 'macho-executable' | 'script' | 'shortcut' | 'installer' | 'office-document' | 'unknown-binary' | 'empty'

const startsWith = (b: Buffer, bytes: number[], offset = 0): boolean => b.length >= offset + bytes.length && bytes.every((v, i) => b[offset + i] === v)

/** What a file is, from its content. Text is recognised by being valid UTF-8 without control bytes in its first kilobytes. */
export function sniff(body: Buffer): SniffedKind {
  if (body.length === 0) return 'empty'
  if (startsWith(body, [0x4d, 0x5a])) return 'windows-executable' // MZ: exe, dll, scr, sys
  if (startsWith(body, [0x7f, 0x45, 0x4c, 0x46])) return 'elf-executable'
  if (startsWith(body, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(body, [0xfe, 0xed, 0xfa, 0xcf]) || startsWith(body, [0xca, 0xfe, 0xba, 0xbe])) return 'macho-executable'
  if (startsWith(body, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return 'shortcut' // .lnk
  if (startsWith(body, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'installer' // OLE compound file: msi, and old Office with macros
  if (startsWith(body, [0x25, 0x50, 0x44, 0x46])) return 'pdf'
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47])) return 'png'
  if (startsWith(body, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(body, [0x47, 0x49, 0x46, 0x38])) return 'gif'
  if (startsWith(body, [0x52, 0x49, 0x46, 0x46]) && startsWith(body, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp'
  if (startsWith(body, [0x50, 0x4b, 0x03, 0x04]) || startsWith(body, [0x50, 0x4b, 0x05, 0x06])) {
    // A zip that is an Office document can carry macros; one that is a package can carry anything.
    const head = body.subarray(0, 4096).toString('latin1')
    return /word\/|xl\/|ppt\/|\[Content_Types\]\.xml/.test(head) ? 'office-document' : 'zip'
  }
  if (startsWith(body, [0x1f, 0x8b])) return 'gzip'
  if (startsWith(body, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'sevenzip'
  if (body.length > 262 && body.subarray(257, 262).toString('latin1') === 'ustar') return 'tar'
  const head = body.subarray(0, 4096)
  // eslint-disable-next-line no-control-regex
  const looksText = !/[\u0000-\u0008\u000e-\u001a]/.test(head.toString('latin1')) && !head.toString('utf8').includes('\ufffd')
  if (!looksText) return 'unknown-binary'
  const text = head.toString('utf8').replace(/^\ufeff/, '').trimStart()
  if (/^#!/.test(text) || /^(@echo off|\[InternetShortcut\]|<\?php|<script\b|Windows Registry Editor|REGEDIT4)/i.test(text)) return /InternetShortcut/i.test(text) ? 'shortcut' : 'script'
  if (/^(param\s*\(|function\s+[\w-]+\s*\{|\$ErrorActionPreference|Set-StrictMode|Import-Module|Add-Type)/i.test(text)) return 'script'
  if (/^[[{]/.test(text)) return 'json'
  if (/^<(\?xml|!DOCTYPE|[a-zA-Z])/.test(text)) return 'xml'
  return 'text'
}

/** Kinds that are held. Everything else is refused: it is a program, or NEXUS cannot tell that it is not. */
const HELD: ReadonlySet<SniffedKind> = new Set(['pdf', 'png', 'jpeg', 'gif', 'webp', 'zip', 'gzip', 'tar', 'sevenzip', 'text', 'json', 'xml'])

/** Names that Windows runs or opens with something that runs them. Judged on every dot-separated part: `report.pdf.exe` is an exe. */
const RUNNABLE_EXTENSION = /^(exe|dll|scr|com|pif|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|msix|appx|lnk|url|reg|jar|cpl|sys|drv|inf|scf|application|gadget|iso|img|vhd|vhdx|docm|xlsm|pptm|dotm|xlam|chm|sh|py|rb|pl)$/i

export function nameIsRunnable(name: string | null): boolean {
  if (name === null || name === '') return false
  return name
    .split(/[\\/]/)
    .pop()!
    .split('.')
    .slice(1)
    .some((part) => RUNNABLE_EXTENSION.test(part.trim()))
}

export interface QuarantineDecision {
  state: 'QUARANTINED' | 'REFUSED'
  sniffed: SniffedKind
  refusal: string | null
  sha256: string
  /** The file's place in quarantine, when it was kept. */
  path: string | null
}

export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

/**
 * Judges a downloaded body and, when it may be kept, writes it into `dir` under `<id>.quarantined`, marked as
 * come from the Internet (the Zone.Identifier stream, so that Windows treats a later copy as such too).
 */
export function quarantine(dir: string, id: string, body: Buffer, info: { url: string; suggestedName: string | null; truncated: boolean }): QuarantineDecision {
  const sha256 = createHash('sha256').update(body).digest('hex')
  const sniffed = sniff(body)
  const refuse = (refusal: string): QuarantineDecision => ({ state: 'REFUSED', sniffed, refusal, sha256, path: null })
  if (info.truncated || body.length > MAX_DOWNLOAD_BYTES) return refuse('The file is larger than the download limit.')
  if (!HELD.has(sniffed)) return refuse(`The content is a ${sniffed.replace(/-/g, ' ')}; files of that kind are not kept.`)
  if (nameIsRunnable(info.suggestedName)) return refuse('The name the server gave the file is one Windows would run.')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.quarantined`)
  writeFileSync(path, body, { flag: 'wx' })
  try {
    // An alternate data stream; absent on a file system that has none, which changes nothing about where the file is.
    writeFileSync(`${path}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${info.url.replace(/[\r\n]/g, '').slice(0, 2000)}\r\n`)
  } catch {
    // not NTFS
  }
  return { state: 'QUARANTINED', sniffed, refusal: null, sha256, path }
}
