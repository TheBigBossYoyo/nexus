import type { DisturbanceEvent, PresentationCompatibility, PresentationMode, UserDisturbanceMetrics } from '@shared/presentation'
import type { PresentationStore } from './store'

/**
 * 0.9.1: zero-disturbance testing (C1, C17). The TestPresentationManager decides where an application under test is
 * shown, from what was measured of that application (PresentationCompatibilityProfile); the metrics say what NEXUS's
 * work did to the owner's screen during a mission, from the presence meter.
 *
 * Presentation is not authority (C6): a desktop of its own keeps a window off the screen; it contains nothing.
 * The containment of 0.8 decides what the application can reach, whatever the mode.
 */

export type AppKind = 'web' | 'electron' | 'native'

export interface PresentationChoice {
  mode: PresentationMode
  /** Why, in one sentence, from the evidence when there is some. */
  why: string
  /** Only a visible window can test this application: run it when the owner is away, or tell them first (C11). */
  visibleRequired: boolean
}

/**
 * The mode for an application: HEADLESS, then HIDDEN, then a desktop of its own, then a window in the background,
 * then a visible window as the last resort (C1). A mode is used only where the evidence does not say it changes
 * what is tested (C4): a mode measured VISIBLE_REQUIRED is skipped, HIDDEN is used for Electron only once it was
 * measured SUPPORTED (it changes how the application is started), and with no evidence an Electron or native
 * application gets a desktop of its own, which shows real windows to nobody.
 */
export function choosePresentation(kind: AppKind, evidence: readonly PresentationCompatibility[]): PresentationChoice {
  const verdict = (mode: PresentationMode) => evidence.find((e) => e.mode === mode)?.verdict ?? 'UNTESTED'
  const usable = (mode: PresentationMode) => verdict(mode) === 'SUPPORTED' || verdict(mode) === 'SUPPORTED_WITH_LIMITATION'
  if (kind === 'web') {
    if (verdict('HEADLESS') !== 'VISIBLE_REQUIRED') return { mode: 'HEADLESS', why: verdict('HEADLESS') === 'UNTESTED' ? 'A web application is tested in a headless browser.' : `Headless was measured ${verdict('HEADLESS')}.`, visibleRequired: false }
    if (verdict('ISOLATED_DESKTOP') !== 'VISIBLE_REQUIRED') return { mode: 'ISOLATED_DESKTOP', why: 'Headless changes what this page renders; a real browser window on a desktop of its own does not.', visibleRequired: false }
    return { mode: 'VISIBLE', why: 'Only a visible browser window renders this page as it is.', visibleRequired: true }
  }
  if (kind === 'electron' && usable('HIDDEN')) return { mode: 'HIDDEN', why: `Hidden windows were measured ${verdict('HIDDEN')} for this application.`, visibleRequired: false }
  if (verdict('ISOLATED_DESKTOP') !== 'VISIBLE_REQUIRED') return { mode: 'ISOLATED_DESKTOP', why: verdict('ISOLATED_DESKTOP') === 'UNTESTED' ? 'Its windows are real, on a desktop of its own that nobody sees.' : `A desktop of its own was measured ${verdict('ISOLATED_DESKTOP')}.`, visibleRequired: false }
  if (verdict('BACKGROUND') !== 'VISIBLE_REQUIRED') return { mode: 'BACKGROUND', why: 'It needs the interactive desktop; it is started without taking the focus.', visibleRequired: false }
  return { mode: 'VISIBLE', why: 'Only a visible window on the interactive desktop tests it as it is.', visibleRequired: true }
}

/**
 * When a test that needs a visible window may run (C11, C19): at night with the owner away, or when they are idle;
 * while they use the PC it waits for a quiet moment. Never falsified: a test that cannot run is reported as not run.
 */
export function visibleTestDecision(input: { overnight: boolean; userIdleSeconds: number | null }): 'RUN' | 'WAIT_FOR_IDLE' {
  if (input.overnight && (input.userIdleSeconds === null || input.userIdleSeconds >= 300)) return 'RUN'
  if (input.userIdleSeconds !== null && input.userIdleSeconds >= 600) return 'RUN'
  return 'WAIT_FOR_IDLE'
}

export interface PresentationServiceDeps {
  store: PresentationStore
  /** Whether the meter runs now (Windows, helper present). */
  measuring: () => boolean
  /** UAC prompts the owner accepted for a run (its privilege sessions). */
  uacPrompts: (runId: string) => number
  /** Commands of projects that are not contained started quietly since NEXUS started. */
  quietCommands: () => number
  onChange?: (runIds: string[]) => void
}

export class PresentationService {
  constructor(private readonly d: PresentationServiceDeps) {}

  record(event: DisturbanceEvent): void {
    this.d.store.record(event)
    if (event.runIds.length > 0) this.d.onChange?.(event.runIds)
  }

  metrics(runId: string): UserDisturbanceMetrics {
    const c = this.d.store.counts(runId)
    return {
      runId,
      measured: this.d.measuring(),
      uacPrompts: this.d.uacPrompts(runId),
      visibleWindows: c.VISIBLE_WINDOW,
      foregroundSteals: c.FOREGROUND_STEAL,
      consoleFlashes: c.CONSOLE_FLASH,
      unexpectedDialogs: c.SYSTEM_DIALOG,
      notifications: null,
      recent: this.d.store.recent(runId, 20),
      quietCommands: this.d.quietCommands(),
    }
  }

  choose(projectId: string, appKey: string, kind: AppKind): PresentationChoice {
    return choosePresentation(kind, this.d.store.compatibility(projectId, appKey))
  }

  saveEvidence(c: PresentationCompatibility): void {
    this.d.store.saveCompatibility(c)
  }

  /** The section of a report: what the night or the mission did to the owner's screen. */
  section(runId: string): string {
    const m = this.metrics(runId)
    const lines = ['## User disturbance', '']
    if (!m.measured && m.recent.length === 0) return [...lines, 'Not measured: the presence meter did not run.', ''].join('\n')
    lines.push(
      `- UAC prompts: ${m.uacPrompts}`,
      `- Visible windows of NEXUS's work: ${m.visibleWindows}`,
      `- Windows that took the foreground: ${m.foregroundSteals}`,
      `- Console windows: ${m.consoleFlashes}`,
      `- Unexpected dialogs: ${m.unexpectedDialogs}`,
      '- Notifications: not measured',
    )
    const shown = m.recent.filter((e) => e.kind !== 'FOCUSED_LATER' && e.kind !== 'NEXUS_CONFIRMATION')
    if (shown.length > 0) {
      lines.push('', 'What was seen (process, window class):')
      for (const e of shown.slice(-10)) lines.push(`- ${e.at.slice(11, 16)} ${e.kind.toLowerCase().replace(/_/g, ' ')}: ${e.process} (${e.windowClass})`)
    }
    lines.push('')
    return lines.join('\n')
  }
}
