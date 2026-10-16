/**
 * 0.9.1: what was typed in a composer and not sent yet, kept per key (a project) while the window lives: leaving
 * the tab threw a long mission prompt away. Kept in memory and in the session's storage, which may be unavailable;
 * nothing here is sent anywhere.
 */

const memory = new Map<string, string>()
const storageKey = (key: string): string => `nexus.draft.${key}`

export function readDraft(key: string): string {
  const kept = memory.get(key)
  if (kept !== undefined) return kept
  try {
    return window.sessionStorage.getItem(storageKey(key)) ?? ''
  } catch {
    return ''
  }
}

export function writeDraft(key: string, text: string): void {
  memory.set(key, text)
  try {
    if (text === '') window.sessionStorage.removeItem(storageKey(key))
    else window.sessionStorage.setItem(storageKey(key), text)
  } catch {
    // Storage unavailable: the draft lives in memory only.
  }
}
