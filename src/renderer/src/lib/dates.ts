/**
 * One explicit date format for the Control Center and its neighbours, so a window never mixes the computer's
 * language into English text ("next mercredi"). British order, long month: "6 October 2026, 21:30".
 */
const LOCALE = 'en-GB'

const valid = (iso: string | number | null | undefined): Date | null => {
  if (iso === null || iso === undefined || iso === '') return null
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d : null
}

export function formatWhen(iso: string | number | null | undefined): string {
  const d = valid(iso)
  return d ? d.toLocaleString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
}

export function formatWeekday(d: Date): string {
  return d.toLocaleDateString(LOCALE, { weekday: 'long' })
}

export function formatClock(d: Date): string {
  return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
}
