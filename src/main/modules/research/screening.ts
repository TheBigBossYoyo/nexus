/**
 * 0.8: screening of untrusted text for instruction-like content. A secondary layer. It lowers the chance that
 * a page's "ignore your instructions" is read as anything but a quotation, and it leaves a finding. It is not
 * a gate: what a session can do is fixed by its capabilities whether or not this found anything, and a page
 * that slips past it has gained nothing but a reader. It never stops a task and never asks the user.
 */

export type ScreeningPattern =
  | 'role_override'
  | 'addressed_to_agent'
  | 'action_imperative'
  | 'exfiltration'
  | 'secrecy'
  | 'fake_delimiter'
  | 'policy_tamper'
  | 'invisible_characters'

export interface QuarantinedSpan {
  /** Offset and length in the text that was screened (after normalization). */
  offset: number
  length: number
  pattern: ScreeningPattern
}

export interface ScreeningResult {
  status: 'clean' | 'flagged'
  layers: string[]
  quarantined: QuarantinedSpan[]
  /** Invisible and direction-control characters removed before matching. */
  strippedCharacters: number
  /** The text with each quarantined span replaced by a marker that says what was there and how long it was. */
  text: string
}

export const SCREENING_LAYER = 'heuristic/1'

interface Rule {
  pattern: ScreeningPattern
  re: RegExp
}

/**
 * High-confidence forms only: each is a sentence aimed at the reader as an agent. Words such as "run", "curl"
 * or "token" alone are what documentation is made of and are not flagged.
 */
const RULES: Rule[] = [
  { pattern: 'role_override', re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:all|any|the|your|previous|prior|above|earlier)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|directions?|guidelines|context)\b/gi },
  { pattern: 'role_override', re: /\b(?:you are now|from now on,? you|new instructions?:|your new (?:task|role|instructions?)|act as (?:an? )?(?:unrestricted|jailbroken|developer mode))\b/gi },
  { pattern: 'role_override', re: /\b(?:reveal|print|show|output|repeat)\b[^.\n]{0,30}\b(?:system prompt|developer message|hidden instructions?|initial instructions?)\b/gi },
  { pattern: 'addressed_to_agent', re: /\b(?:if you are|attention|note to|message for|dear)\b[^.\n]{0,20}\b(?:an? )?(?:ai|a\.i\.|llm|language model|assistant|agent|claude|chatgpt|gpt|copilot|bot)\b/gi },
  { pattern: 'addressed_to_agent', re: /\b(?:ai|llm|assistant|agent)s?\b[^.\n]{0,15}\b(?:must|should|are required to|need to)\b[^.\n]{0,60}\b(?:run|execute|send|upload|read|open|navigate|download|disable|delete|post)\b/gi },
  { pattern: 'action_imperative', re: /\b(?:download|fetch|get)\b[^.\n]{0,60}\b(?:and|then)\b[^.\n]{0,20}\b(?:run|execute|install)\b[^.\n]{0,40}/gi },
  { pattern: 'action_imperative', re: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|\n]{0,200}\|\s*(?:sh|bash|zsh|iex|invoke-expression|powershell|pwsh|python)\b/gi },
  { pattern: 'action_imperative', re: /\b(?:navigate|go|browse|connect)\b[^.\n]{0,15}\bto\b[^.\n]{0,20}\b(?:localhost|127\.0\.0\.1|\[?::1\]?|file:\/\/|169\.254\.169\.254)\S*/gi },
  { pattern: 'exfiltration', re: /\b(?:send|upload|post|email|exfiltrate|transmit|paste|forward)\b[^.\n]{0,60}(?:\.env\b|\b(?:credentials?|secrets?|tokens?|api keys?|ssh keys?|cookies?|passwords?|your files|the (?:source|repository|codebase)|environment variables)\b)/gi },
  { pattern: 'exfiltration', re: /\b(?:read|open|cat|print|dump)\b[^.\n]{0,30}(?:\.env\b|\bid_rsa|\.ssh[\\/]|\.aws[\\/]|\bcredentials\.json|\.npmrc|\.netrc)[^.\n]{0,60}\b(?:and|then)\b[^.\n]{0,20}\b(?:send|post|upload|include|append)\b/gi },
  { pattern: 'exfiltration', re: /\b(?:use|with|include)\b[^.\n]{0,20}\byour\b[^.\n]{0,20}\b(?:github|google|aws|session|login|browser)\b[^.\n]{0,15}\b(?:cookies?|tokens?|credentials?|session)\b/gi },
  { pattern: 'secrecy', re: /\b(?:do not|don't|never)\b[^.\n]{0,15}\b(?:tell|inform|mention|reveal|notify|alert)\b[^.\n]{0,25}\b(?:the user|your user|anyone|the human|the operator)\b/gi },
  { pattern: 'policy_tamper', re: /\b(?:disable|turn off|bypass|remove|ignore)\b[^.\n]{0,30}\b(?:your|nexus(?:'s)?)\s+(?:own\s+)?(?:security (?:polic(?:y|ies)|rules|checks|settings)|safety (?:rules|checks|polic(?:y|ies))|sandbox|guardrails|approval(?:s| checks)?|permission checks?)\b/gi },
  { pattern: 'policy_tamper', re: /\b(?:grant|give) (?:yourself|me|this page)\b[^.\n]{0,40}\b(?:permission|access|capabilit(?:y|ies)|authority)\b/gi },
  { pattern: 'fake_delimiter', re: /<\/?(?:system|assistant|user|human|tool_result|function_results?|instructions?)>|<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|^#{2,4}\s*(?:system|instruction|new instruction)s?\b.*$|^(?:Human|Assistant|System)\s*:\s/gim },
]

// Zero-width, bidirectional controls, the Unicode tag block and other characters that render as nothing.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]|\udb40[\udc00-\udc7f]/g

/** Widens a match to the sentence or line around it, so that the whole instruction is taken out, not three words of it. */
function widen(text: string, start: number, end: number): [number, number] {
  const MAX = 400
  let s = start
  while (s > 0 && start - s < MAX && !/[\n.!?]/.test(text[s - 1] as string)) s -= 1
  let e = end
  while (e < text.length && e - end < MAX && !/[\n.!?]/.test(text[e] as string)) e += 1
  if (e < text.length && /[.!?]/.test(text[e] as string)) e += 1
  while (s < start && /\s/.test(text[s] as string)) s += 1
  return [s, e]
}

/**
 * Screens text that came from outside. Returns the text with instruction-like spans replaced by a marker. The
 * factual content around them stays: a page about prompt injection, or a shell tutorial, is still a source.
 */
export function screenUntrustedText(input: string): ScreeningResult {
  const normalized = input.normalize('NFKC')
  let stripped = 0
  const text = normalized.replace(INVISIBLE, () => {
    stripped += 1
    return ''
  })
  const found: QuarantinedSpan[] = []
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex += 1
        continue
      }
      const [s, e] = widen(text, m.index, m.index + m[0].length)
      found.push({ offset: s, length: e - s, pattern: rule.pattern })
      if (found.length >= 200) break
    }
  }
  // A long run of invisible characters is itself a finding: nothing a reader sees needs it.
  if (stripped >= 16) found.push({ offset: 0, length: 0, pattern: 'invisible_characters' })

  // Overlapping spans become one, named after the first rule that found it.
  const spans = found.filter((f) => f.length > 0).sort((a, b) => a.offset - b.offset || b.length - a.length)
  const merged: QuarantinedSpan[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.offset <= last.offset + last.length) last.length = Math.max(last.length, span.offset + span.length - last.offset)
    else merged.push({ ...span })
  }
  let out = ''
  let cursor = 0
  for (const span of merged) {
    out += text.slice(cursor, span.offset)
    out += `[quarantined: instruction-like text, ${span.length} characters, pattern=${span.pattern}]`
    cursor = span.offset + span.length
  }
  out += text.slice(cursor)
  const quarantined = [...merged, ...found.filter((f) => f.length === 0)]
  return { status: quarantined.length > 0 ? 'flagged' : 'clean', layers: [SCREENING_LAYER], quarantined, strippedCharacters: stripped, text: out }
}
