/**
 * 0.9.1, local speech: the text side, pure functions. A guess between English and French, the text made ready
 * for a voice (without changing any figure), a long sentence cut at clause boundaries, and the correction of a
 * spoken project name to its written form. Nothing here touches a model, a file or the clock.
 */

export type SpeechLanguage = 'en' | 'fr'

const EN_WORDS = new Set(
  ('the is are was were and to of in it its it\'s that this these those what how when where why who which with for will would can could ' +
    'have has had not no yes you your me my we our they them he she his her i am be been do does did done please call tell pause stop ' +
    'start after before then now still already about from as at by on or if so but there here task tasks project going blocking blocked ' +
    'status progress finished ready next last more less than too very just all any some').split(' '),
)
const FR_WORDS = new Set(
  ('le la les un une des du de d l au aux et est sont était été être suis es ce cet cette ces ça ca qui que qu quoi quel quelle ' +
    'comment pourquoi quand où avec pour dans sur sous par pas ne n plus moins très tout tous toute je j tu il elle on nous vous ils elles ' +
    'mon ma mes ton ta tes son sa ses notre votre vos leur leurs oui non merci bonjour bloque avance avancer tâche tâches projet ' +
    'ensuite puis après avant maintenant encore déjà fini finie prêt prête appelle appelez dis dites arrête arrêtez pause ' +
    'lance lancé compilation tests terminés ou mais donc car si y a ai as avez avons ont fait faire').split(' '),
)
const EN_DIGITS = new Set('zero oh one two three four five six seven eight nine ten'.split(' '))
const FR_DIGITS = new Set('zéro zero un deux trois quatre cinq six sept huit neuf dix'.split(' '))

function words(text: string): string[] {
  return text.toLowerCase().normalize('NFC').match(/[a-zàâäçéèêëîïôöùûüÿœæ]+/g) ?? []
}

/**
 * Which of English and French a sentence is written in, by function words, accents and digit words. Cheap, and
 * wrong on very short or borrowed-word text: when the evidence is a tie (or there is none) the first candidate
 * wins, which is the first language of the call. A text that cannot be English or French is not told apart here.
 */
export function guessLanguage(text: string, candidates: readonly SpeechLanguage[] = ['en', 'fr']): SpeechLanguage {
  const first = candidates[0] ?? 'en'
  if (candidates.length < 2) return first
  let en = 0
  let fr = 0
  for (const w of words(text)) {
    if (EN_WORDS.has(w)) en += 1
    if (FR_WORDS.has(w)) fr += 1
    if (EN_DIGITS.has(w) && !FR_DIGITS.has(w)) en += 1.5
    if (FR_DIGITS.has(w) && !EN_DIGITS.has(w)) fr += 1.5
  }
  fr += 2 * (text.match(/[àâçéèêëîïôùûüœ]/gi)?.length ?? 0)
  if (/\b(qu'|l'|d'|j'|n'|c'|s'|m'|t')/i.test(text)) fr += 2
  if (/\b(the|and|is|you)\b/i.test(text)) en += 0.5
  if (en === fr) return first
  const winner: SpeechLanguage = fr > en ? 'fr' : 'en'
  return candidates.includes(winner) ? winner : first
}

const MONTHS: Record<SpeechLanguage, string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
}

const UNITS: Record<string, { en: [string, string]; fr: [string, string] }> = {
  min: { en: ['minute', 'minutes'], fr: ['minute', 'minutes'] },
  mins: { en: ['minute', 'minutes'], fr: ['minute', 'minutes'] },
  h: { en: ['hour', 'hours'], fr: ['heure', 'heures'] },
  hr: { en: ['hour', 'hours'], fr: ['heure', 'heures'] },
  hrs: { en: ['hour', 'hours'], fr: ['heure', 'heures'] },
  ms: { en: ['millisecond', 'milliseconds'], fr: ['milliseconde', 'millisecondes'] },
  sec: { en: ['second', 'seconds'], fr: ['seconde', 'secondes'] },
  secs: { en: ['second', 'seconds'], fr: ['seconde', 'secondes'] },
}

function unitWord(unit: string, lang: SpeechLanguage, plural: boolean): string {
  const u = UNITS[unit.toLowerCase()]
  if (!u) return unit
  return u[lang][plural ? 1 : 0]
}

/**
 * Makes written text read well aloud, without ever changing a figure: the digits are kept and the voice reads
 * them. Percentages, number ranges with a unit ("25–40 min"), dates and times in ISO form, and markup that has
 * no sound ("**", back quotes, a heading mark) are handled; everything else is left as it is.
 */
export function normalizeForSpeech(text: string, lang: SpeechLanguage): string {
  let t = text.normalize('NFC')
  // Markup without sound.
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/[`*]+/g, '').replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/https?:\/\/\S+/gi, lang === 'fr' ? 'un lien' : 'a link')
  // ISO date with an optional time: 2026-10-13, 2026-10-13T14:30:00Z.
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, (all, y: string, mo: string, d: string, hh?: string, mm?: string) => {
    const month = Number(mo)
    const day = Number(d)
    if (month < 1 || month > 12 || day < 1 || day > 31) return all
    const date = lang === 'fr' ? `${day === 1 ? '1er' : String(day)} ${MONTHS.fr[month - 1]} ${y}` : `${MONTHS.en[month - 1]} ${day}, ${y}`
    return hh !== undefined && mm !== undefined ? `${date} ${lang === 'fr' ? 'à' : 'at'} ${spokenTime(hh, mm, lang)}` : date
  })
  // A time, 14:30 (not part of a longer run of colons or a ratio like 3:2:1).
  t = t.replace(/(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g, (_all, hh: string, mm: string) => spokenTime(hh, mm, lang))
  // A range with a dash: always with an en or em dash between numbers; a hyphen only when a unit follows.
  const unitRe = Object.keys(UNITS).join('|')
  t = t.replace(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:[–—]|-(?=\\s*\\d+(?:[.,]\\d+)?\\s*(?:${unitRe})\\b))\\s*(\\d+(?:[.,]\\d+)?)(?:\\s*(${unitRe})\\b)?`, 'gi'), (_all, a: string, b: string, unit?: string) => {
    const to = lang === 'fr' ? 'à' : 'to'
    return unit ? `${a} ${to} ${b} ${unitWord(unit, lang, true)}` : `${a} ${to} ${b}`
  })
  // A figure with a unit that is spoken in full.
  t = t.replace(new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(${unitRe})\\b(?!-)`, 'gi'), (_all, n: string, unit: string) => `${n} ${unitWord(unit, lang, Number(n.replace(',', '.')) !== 1)}`)
  // Percentages.
  t = t.replace(/(\d+(?:[.,]\d+)?)\s*%/g, (_all, n: string) => `${n} ${lang === 'fr' ? 'pour cent' : 'percent'}`)
  t = t.replace(/\s*\r?\n+\s*/g, '. ').replace(/\.\s*\.(\s|$)/g, '.$1')
  return t.replace(/[ \t]{2,}/g, ' ').trim()
}

function spokenTime(hh: string, mm: string, lang: SpeechLanguage): string {
  const h = String(Number(hh))
  if (lang === 'fr') return mm === '00' ? `${h} heures` : `${h} h ${Number(mm)}`
  if (mm === '00') return Number(hh) === 0 || Number(hh) > 12 ? `${h} hundred hours` : `${h} o'clock`
  return Number(mm) < 10 ? `${h} oh ${Number(mm)}` : `${h} ${mm}`
}

/**
 * Cuts a long sentence at clause boundaries (a comma, a semicolon, a colon, a dash) so that the first sound
 * comes while the rest is still to be made. A sentence that is not long is left whole; a clause is never shorter
 * than `minChars`, so that the voice does not speak in fragments.
 */
export function splitClauses(text: string, options: { maxChars?: number; minChars?: number; firstMinChars?: number } = {}): string[] {
  const maxChars = options.maxChars ?? 90
  const minChars = options.minChars ?? 28
  // The first clause is the one the caller waits for: it may be short.
  const firstMinChars = options.firstMinChars ?? 16
  const t = text.trim()
  if (t.length <= maxChars) return t ? [t] : []
  const pieces = t.split(/(?<=[,;:—–])\s+/).filter((p) => p.length > 0)
  const out: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (current.length === 0) current = piece
    else if (current.length < (out.length === 0 ? firstMinChars : minChars)) current = `${current} ${piece}`
    else {
      out.push(current)
      current = piece
    }
  }
  if (current.length > 0) {
    if (out.length > 0 && current.length < minChars) out[out.length - 1] = `${out[out.length - 1]} ${current}`
    else out.push(current)
  }
  return out
}

function squash(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length] as number
}

/**
 * A recogniser writes what it hears ("race deck"); a project is named "RaceDeck". Where one to four words in a
 * row, run together, are the same as a name in `hints` (or one letter off for a short name, two for one of eight
 * letters or more), the name is written as it is spelled. Nothing else is changed. This is a correction after the fact: the
 * decoder is not biased (see the note on hot words in local-speech.ts).
 */
export function snapToHints(text: string, hints: readonly string[]): string {
  const names = hints.map((h) => ({ name: h, key: squash(h) })).filter((h) => h.key.length >= 4)
  if (names.length === 0 || text.length === 0) return text
  const parts = text.split(/(\s+)/)
  const idx: number[] = []
  parts.forEach((p, i) => {
    if (!/^\s*$/.test(p)) idx.push(i)
  })
  // The best name for the words that start at w: the fewest letters off, then the fewest words.
  const bestAt = (w: number): { span: number; name: string; trail: string; dist: number } | null => {
    let best: { span: number; name: string; trail: string; dist: number } | null = null
    for (let span = 1; span <= Math.min(4, idx.length - w); span += 1) {
      const slice = idx.slice(w, w + span).map((i) => parts[i] as string)
      const last = slice[span - 1] as string
      const trail = /[.,;:!?…»"')\]]+$/.exec(last)?.[0] ?? ''
      const core = slice.slice(0, -1).concat(trail ? last.slice(0, last.length - trail.length) : last)
      const key = squash(core.join(''))
      if (key.length < 4) continue
      for (const n of names) {
        const limit = n.key.length >= 8 ? 2 : n.key.length >= 5 ? 1 : 0
        const dist = editDistance(key, n.key, limit)
        if (dist <= limit && (best === null || dist < best.dist)) best = { span, name: n.name, trail, dist }
      }
    }
    return best
  }
  const out: string[] = []
  let w = 0
  while (w < idx.length) {
    let hit = bestAt(w)
    // A match that starts one word later and is closer is the real one ("is race deck": the name starts at "race").
    if (hit !== null && hit.dist > 0) {
      const later = bestAt(w + 1)
      if (later !== null && later.dist < hit.dist) hit = null
    }
    if (hit !== null) {
      out.push(hit.name + hit.trail)
      const nextSep = parts[(idx[w + hit.span - 1] as number) + 1]
      if (nextSep !== undefined && /^\s+$/.test(nextSep)) out.push(nextSep)
      w += hit.span
    } else {
      out.push(parts[idx[w] as number] as string)
      const sep = parts[(idx[w] as number) + 1]
      if (sep !== undefined && /^\s+$/.test(sep)) out.push(sep)
      w += 1
    }
  }
  const lead = /^\s+/.exec(text)?.[0] ?? ''
  return lead + out.join('')
}

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  zéro: '0', un: '1', une: '1', deux: '2', trois: '3', quatre: '4', cinq: '5', sept: '7', huit: '8', neuf: '9',
}
// What a recogniser writes for a digit word it half heard, accepted only inside a run of digit words.
const DIGIT_HOMOPHONES: Record<string, string> = {
  for: '4', fore: '4', to: '2', too: '2', won: '1', ate: '8', tree: '3', sicks: '6', nein: '9',
  de: '2', deu: '2', en: '1', cette: '7', sète: '7', sain: '5', sink: '5', cinque: '5', huile: '8', huiles: '8', neu: '9', ne: '9', quart: '4',
}

/**
 * Reads a spoken string of digits ("four eight two nine one five", "quatre huit deux neuf un cinq") as digits, or
 * null when it is not one: at least `minDigits` words, every one a digit word or, because recognisers mishear
 * them, a near-homophone of one ("for" for four). It does not fix a digit that was heard as something else, and
 * never invents one: a run with a word that is neither is not a PIN. A caller may use it to read a spoken PIN, with
 * the knowledge that a PIN heard this way can be wrong; the keypad of the phone cannot.
 */
export function spokenDigits(text: string, minDigits = 4): string | null {
  const ws = words(text)
  if (ws.length < minDigits) return null
  let out = ''
  for (const w of ws) {
    const d = DIGIT_WORDS[w] ?? DIGIT_HOMOPHONES[w]
    if (d === undefined) return null
    out += d
  }
  return out.length >= minDigits ? out : null
}

