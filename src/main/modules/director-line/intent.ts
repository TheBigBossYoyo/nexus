import type { OperatorCommand, OperatorCommandKind, RefusedTopic } from '@shared/director-line'

/**
 * Turns an AUTHENTICATED message from the paired operator into one command of a closed set. Deterministic patterns
 * first (English and French); an optional cheap-model hook only for what the patterns do not recognise.
 *
 * Authority: a command here is never more than "read this", "pause/continue", or "hand this text to the ordinary
 * mission-creation path". The words of the operator are carried as the user's words, and nothing in them can widen
 * what NEXUS may do: this module imports nothing that could (no broker, no settings, no power), so there is no
 * code path to take even if the text says "ignore previous instructions". Whatever looks destructive or
 * high-authority is turned into REFUSED_AT_MACHINE with a fixed topic label and never executed through the line.
 */

export const MAX_INBOUND_CHARS = 4000
export const MAX_TASK_CHARS = 2000

/** Removes control characters, bidirectional overrides and zero-width characters, collapses runs of blanks, caps the length. */
export function sanitizeInbound(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{3,}/g, '  ')
    .slice(0, MAX_INBOUND_CHARS)
    .trim()
}

/**
 * Lower-cases and removes diacritics character by character, so the result has the SAME length as the input and
 * indices found in it can be used on the original text.
 */
export function fold(text: string): string {
  let out = ''
  for (const ch of text) {
    const d = ch.normalize('NFD')
    const base = d.length > 1 && /\p{M}/u.test(d.slice(1)) ? d[0]! : ch
    const low = base.toLowerCase()
    out += low.length === ch.length ? low : ch
  }
  return out.replace(/[’‘`´]/g, "'")
}

interface DangerRule { topic: RefusedTopic; pattern: RegExp }

const DANGER: DangerRule[] = [
  { topic: 'PUSH_OR_PUBLISH', pattern: /\b(?:push|publish|deploy|ship it|release it|pousse\w*|publie\w*|deploie\w*|mets? en prod\w*|mise? en prod\w*|git push)\b/ },
  { topic: 'DESTRUCTIVE', pattern: /\b(?:delete|wipe|erase|rm\s+-rf|drop\s+(?:table|database)|reset\s+--hard|format\s+[a-z]:|supprim\w*|efface\w*|detruis|detruire|nettoie tout)\b/ },
  { topic: 'SANDBOX_OR_AUTONOMY', pattern: /\b(?:sandbox|bac a sable|autonomy|autonomie|appcontainer)\b|\b(?:disable|turn off|switch off|bypass|desactiv\w*|contourn\w*|coupe)\b[^\n]{0,40}\b(?:policy|policies|politique|protection|security|securite|guard\w*|verification\w*|checks?|confirmation|dialog)\b/ },
  { topic: 'BOUNDARY_REQUEST', pattern: /\b(?:allow|grant|approve|accept|authori[sz]e|autorise\w*|approuve\w*|accorde\w*|permets?|valide\w*)\b/ },
  { topic: 'POWER', pattern: /\b(?:shut\s?down|power\s?off|hibernate|reboot|restart\s+(?:the\s+)?(?:pc|computer|machine)|eteins|eteindre|arrete\s+(?:le\s+)?(?:pc|ordinateur)|redemarr\w*|mise? en veille|mets? en veille)\b/ },
  { topic: 'CREDENTIALS', pattern: /\b(?:credentials?|passwords?|passwd|api[\s_-]?keys?|secrets?|tokens?|ssh[\s_-]?keys?|private[\s_-]?keys?|mots? de passe|identifiants?|cles? api)\b/ },
  { topic: 'RUN_COMMAND', pattern: /^\s*(?:run|exec|execute|sudo|lance|execute)\b|\b(?:run|execute|exec|lance|execute)\b[^\n]{0,25}\b(?:command|commande|script|shell|terminal|powershell|cmd)\b|\b(?:powershell|cmd\.exe|bash\s+-c|invoke-expression|iex)\b/ },
]

/** The first dangerous topic in a message, or null. Run on the folded text of the whole message. */
export function detectRefusedTopic(foldedText: string): RefusedTopic | null {
  for (const rule of DANGER) if (rule.pattern.test(foldedText)) return rule.topic
  return null
}

const ADD_AFTER: RegExp[] = [
  /\bafter (?:this|that|the current (?:program|task|mission|work)),?\s*add\b\s*(?:(?:a|this|the)\s+)?(?:task\s+)?[:,-]?\s*(.+)/ds,
  /\badd\s+(?:this\s+|a\s+)?(?:new\s+)?task\s+after\s+(?:the\s+)?(?:current|this)\s+(?:program|task|mission|work)\s*[:,-]?\s*(.+)/ds,
  /\bapres (?:ca|cela|celle-ci|celui-ci|le programme en cours|la tache en cours|la mission en cours),?\s*ajoute\w*\s+(?:(?:une|cette)\s+)?(?:tache\s+)?[:,-]?\s*(.+)/ds,
  /\bajoute\w*\s+(?:cette\s+|une\s+)?(?:nouvelle\s+)?tache\s+apres\s+(?:le\s+|la\s+)?(?:programme|mission|tache)\s+(?:en cours|actuel\w*)\s*[:,-]?\s*(.+)/ds,
  /^\s*add\s+(?:a\s+)?task\s*[:,-]\s*(.+)/ds,
]

const CREATE_FOR: RegExp[] = [
  /\b(?:create|make|open|add|new)\s+(?:a\s+)?(?:new\s+)?task\s+(?:for|in|on)\s+(?:the\s+)?(?:project\s+)?([\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}?)\s*[:,]\s*(.+)/dsu,
  /\b(?:cree\w*|creer|ajoute\w*|nouvelle|ouvre)\s+(?:une\s+)?(?:nouvelle\s+)?tache\s+(?:pour|dans|sur)\s+(?:le\s+)?(?:projet\s+)?([\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}?)\s*[:,]\s*(.+)/dsu,
]

const ETA = /\b(?:how long|time (?:left|remaining)|remaining time|eta\b|when (?:will|does|is)\b[^\n]{0,30}(?:finish|done|ready|complete|over)|how much (?:time|longer)|combien de temps|il reste|reste[- ]t[- ]il|temps restant|quand (?:est[- ]ce que )?(?:ca|cela|ce)\b[^\n]{0,20}(?:fini|term|pret|sera)|ca finit quand|fini(?:ra|t) quand|termine quand)/
const BLOCKERS = /\b(?:block\w*|stuck|waiting (?:on|for)|what(?:'s| is) (?:wrong|the problem)|any problems?|bloqu\w*|coince\w*|empeche\w*|probleme\w*|qu'est[- ]ce qui (?:coince|bloque))/
const TESTS = /\b(?:tests?\s+(?:results?|status)|latest tests?|last tests?|did (?:the )?tests? pass|tests? (?:pass|fail)\w*|resultats? (?:des )?tests?|les tests?|derniers tests?|tests? ok)/
const STATUS = /\b(?:status|statut|etat|how(?:'s| is) it going|how is (?:everything|it)|progress|avancement|ca avance|comment ca (?:va|avance)|ou en (?:est|sommes|en est)|where are we|what happened|what's up|overnight|cette nuit|pendant la nuit|qu'est[- ]ce qui s'est passe|rapport|report|update|point)\b/
const DETAILS = /^\s*(?:details?|detail|detaille|infos?|donne[- ]moi les details (?:de|du|sur)?)\s*[:,-]?\s*(?:(?:on|of|about|for|sur|de|du|pour|the|le|la)\s+)?(.{1,80})$/ds
// "How is RaceDeck going?", "comment avance RaceDeck ?": a question about one piece of work, as it is asked aloud.
const HOW_IS = /^\s*(?:how(?:'s| is| are)\s+(?:the\s+)?(.{1,60}?)\s+(?:going|doing|coming along|progressing|getting on)|comment (?:va|avance|se passe)\s+(?:le\s+|la\s+)?(.{1,60}?))\s*\??\s*$/ds
const HOW_IS_NOBODY = /^(?:it|everything|things|this|that|all|work|the work|ca|tout|le travail)$/
const PAUSE = /\b(?:pause|pauser|suspend\w*|mets? en pause|met en pause|fais une pause|hold on|wait here)\b/
const CONTINUE = /^\s*(?:please\s+|s'il (?:te|vous) plait\s+)?(?:continue\w*|resume|unpause|go on|go ahead|carry on|reprend\w*|reprise|poursui\w*|vas-y|allez-y)\b/
// "Call me": the whole message, so that "call me a taxi" is not a request to ring. English and French.
const CALL_ME = /^\s*(?:please\s+|s'il (?:te|vous) plait,?\s+)?(?:(?:can|could|will|would) you\s+)?(?:call|phone|ring)\s+me(?:\s+(?:now|back|up|please|right now|asap|right away))*\s*[.!?]*\s*$|^\s*(?:s'il (?:te|vous) plait,?\s+)?(?:rappelle|appelle|telephone)(?:-|\s+)moi(?:\s+(?:maintenant|tout de suite|s'il (?:te|vous) plait))*\s*[.!?]*\s*$/
const HELP = /^\s*(?:help|aide|\?|\/help|\/start|menu|commands?|commandes?|what can you do)\b/
// "What did you run as administrator?", "qu'as-tu lancé en administrateur ?": a question about the privileged
// receipts. Only a question: anything that asks for elevation is refused above (BOUNDARY_REQUEST, RUN_COMMAND).
const PRIVILEGED = /\b(?:as (?:an? )?admin\w*|with admin\w*|administrator|admin (?:rights?|operations?|access|commands?)|elevat\w*|privileg\w*|uac|en (?:tant qu')?admin\w*|administrateur|droits? (?:d')?admin\w*|eleve\w*)\b/

function cleanProject(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60)
}

function takeTaskText(original: string, match: RegExpMatchArray, group: number): string | null {
  const span = (match as RegExpMatchArray & { indices?: [number, number][] }).indices?.[group]
  if (!span) return null
  const text = original.slice(span[0], span[1]).trim().slice(0, MAX_TASK_CHARS)
  return text.length >= 3 ? text : null
}

/** Pattern-based interpretation. `original` must already be sanitized. Returns UNKNOWN when nothing matches. */
export function interpretDeterministic(original: string): OperatorCommand {
  const text = fold(original)
  if (text.length === 0) return { kind: 'UNKNOWN' }

  // Tasks first when they are well-formed: "create a task for X: ..." is the user's words and goes the ordinary way.
  for (const re of CREATE_FOR) {
    const m = text.match(re)
    if (m) {
      const span = (m as RegExpMatchArray & { indices?: [number, number][] }).indices
      const project = span?.[1] ? cleanProject(original.slice(span[1][0], span[1][1])) : ''
      const task = takeTaskText(original, m, 2)
      if (project && task) return guardTask({ kind: 'CREATE_TASK', project, text: task })
    }
  }
  for (const re of ADD_AFTER) {
    const m = text.match(re)
    if (m) {
      const task = takeTaskText(original, m, 1)
      if (task) return guardTask({ kind: 'ADD_TASK_AFTER_CURRENT', text: task })
    }
  }

  const refused = detectRefusedTopic(text)
  if (refused) return { kind: 'REFUSED_AT_MACHINE', topic: refused }

  if (PRIVILEGED.test(text) && text.length <= 200) return { kind: 'PRIVILEGED_ACTIVITY' }
  if (CALL_ME.test(text)) return { kind: 'CALL_ME' }
  if (HELP.test(text)) return { kind: 'HELP' }
  if (CONTINUE.test(text) && !PAUSE.test(text)) return { kind: 'CONTINUE' }
  if (PAUSE.test(text) && text.length <= 120) return { kind: 'PAUSE_AFTER_CURRENT_TASK' }
  const details = text.match(DETAILS)
  if (details) {
    const span = (details as RegExpMatchArray & { indices?: [number, number][] }).indices?.[1]
    const subject = span ? cleanProject(original.slice(span[0], span[1])) : ''
    if (subject) return { kind: 'DETAILS', subject }
  }
  const how = text.match(HOW_IS)
  if (how) {
    const indices = (how as RegExpMatchArray & { indices?: ([number, number] | undefined)[] }).indices
    const span = indices?.[1] ?? indices?.[2]
    const subject = span ? cleanProject(original.slice(span[0], span[1])) : ''
    if (subject && !HOW_IS_NOBODY.test(subject.toLowerCase())) return { kind: 'DETAILS', subject }
  }
  if (ETA.test(text)) return { kind: 'ETA' }
  if (TESTS.test(text)) return { kind: 'LATEST_TEST_RESULTS' }
  if (BLOCKERS.test(text)) return { kind: 'BLOCKERS' }
  if (STATUS.test(text)) return { kind: 'STATUS' }
  return { kind: 'UNKNOWN' }
}

/** A task whose own text asks for something high-authority is not queued from away: it must be written at the machine. */
function guardTask(command: Extract<OperatorCommand, { kind: 'CREATE_TASK' | 'ADD_TASK_AFTER_CURRENT' }>): OperatorCommand {
  const refused = detectRefusedTopic(fold(command.text))
  return refused ? { kind: 'REFUSED_AT_MACHINE', topic: refused } : command
}

/** What the hook may return. REFUSED_AT_MACHINE is deliberately not choosable by a model. */
const HOOK_KINDS: readonly OperatorCommandKind[] = ['STATUS', 'ETA', 'BLOCKERS', 'DETAILS', 'LATEST_TEST_RESULTS', 'PRIVILEGED_ACTIVITY', 'PAUSE_AFTER_CURRENT_TASK', 'CONTINUE', 'CALL_ME', 'ADD_TASK_AFTER_CURRENT', 'CREATE_TASK', 'HELP', 'UNKNOWN']

export type IntentClassifier = (text: string) => Promise<unknown>

/**
 * Checks what a cheap model returned. It must be one of the closed set; a task text must appear word for word in the
 * operator's message (the model extracts, it does not author) and must pass the same danger scan.
 */
export function validateClassification(raw: unknown, original: string): OperatorCommand {
  if (!raw || typeof raw !== 'object') return { kind: 'UNKNOWN' }
  const r = raw as { kind?: unknown; subject?: unknown; project?: unknown; text?: unknown }
  if (typeof r.kind !== 'string' || !HOOK_KINDS.includes(r.kind as OperatorCommandKind)) return { kind: 'UNKNOWN' }
  const squash = (s: string): string => fold(s).replace(/\s+/g, ' ').trim()
  const taskText = (): string | null => {
    if (typeof r.text !== 'string') return null
    const t = r.text.trim().slice(0, MAX_TASK_CHARS)
    if (t.length < 3 || !squash(original).includes(squash(t))) return null
    return t
  }
  switch (r.kind) {
    case 'DETAILS': {
      const s = typeof r.subject === 'string' ? cleanProject(r.subject) : ''
      return s ? { kind: 'DETAILS', subject: s } : { kind: 'UNKNOWN' }
    }
    case 'ADD_TASK_AFTER_CURRENT': {
      const t = taskText()
      return t ? guardTask({ kind: 'ADD_TASK_AFTER_CURRENT', text: t }) : { kind: 'UNKNOWN' }
    }
    case 'CREATE_TASK': {
      const t = taskText()
      const p = typeof r.project === 'string' ? cleanProject(r.project) : ''
      return t && p ? guardTask({ kind: 'CREATE_TASK', project: p, text: t }) : { kind: 'UNKNOWN' }
    }
    default:
      return { kind: r.kind } as OperatorCommand
  }
}

export async function interpretMessage(original: string, classify?: IntentClassifier): Promise<OperatorCommand> {
  const clean = sanitizeInbound(original)
  const direct = interpretDeterministic(clean)
  if (direct.kind !== 'UNKNOWN' || !classify) return direct
  // The model sees only the sanitized text of an authenticated operator, and its answer is validated, not obeyed.
  const refused = detectRefusedTopic(fold(clean))
  if (refused) return { kind: 'REFUSED_AT_MACHINE', topic: refused }
  try {
    return validateClassification(await classify(clean), clean)
  } catch {
    return { kind: 'UNKNOWN' }
  }
}

export type CommandRisk = 'READ_ONLY' | 'LOW_RISK_CONTROL' | 'TASK_HANDOFF' | 'REFUSED' | 'NONE'

export function commandRisk(command: OperatorCommand): CommandRisk {
  switch (command.kind) {
    case 'STATUS': case 'ETA': case 'BLOCKERS': case 'DETAILS': case 'LATEST_TEST_RESULTS': case 'PRIVILEGED_ACTIVITY': return 'READ_ONLY'
    case 'PAUSE_AFTER_CURRENT_TASK': case 'CONTINUE': case 'CALL_ME': return 'LOW_RISK_CONTROL'
    case 'ADD_TASK_AFTER_CURRENT': case 'CREATE_TASK': return 'TASK_HANDOFF'
    case 'REFUSED_AT_MACHINE': return 'REFUSED'
    default: return 'NONE'
  }
}
