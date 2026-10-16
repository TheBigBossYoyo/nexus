/**
 * 0.9.1: zero-disturbance testing. How the applications and commands of NEXUS's work are presented (where their
 * windows go), and what they did to the owner's screen, measured.
 */

/** Where an application under test is shown, in the order NEXUS prefers them. VISIBLE is the last resort. */
export const PRESENTATION_MODES = ['HEADLESS', 'HIDDEN', 'ISOLATED_DESKTOP', 'BACKGROUND', 'VISIBLE'] as const
export type PresentationMode = (typeof PRESENTATION_MODES)[number]

/** What a measurement of an application in a mode concluded (C7). */
export const PRESENTATION_VERDICTS = ['SUPPORTED', 'SUPPORTED_WITH_LIMITATION', 'VISIBLE_REQUIRED', 'UNTESTED'] as const
export type PresentationVerdict = (typeof PRESENTATION_VERDICTS)[number]

/** The evidence for one application in one mode: what was checked and what was seen. */
export interface PresentationCompatibility {
  projectId: string
  /** The application: 'electron:<entry>' or 'web:<url origin>'. */
  appKey: string
  mode: PresentationMode
  verdict: PresentationVerdict
  measuredAt: string
  /** Each check and its result (screenshot size, render complete, WebGL, input, accessibility, equivalence). */
  checks: { name: string; ok: boolean; detail: string }[]
  /** Pixel difference to the reference rendering, 0..1, when one was made. */
  difference: number | null
  limitation: string | null
}

/** What NEXUS's work did to the owner's screen, as the presence meter saw it. */
export const DISTURBANCE_KINDS = [
  /** A window of NEXUS's work appeared on the owner's desktop. */
  'VISIBLE_WINDOW',
  /** A console window of NEXUS's work appeared. */
  'CONSOLE_FLASH',
  /** A dialog of NEXUS's work (not one of NEXUS's own confirmations) appeared. */
  'SYSTEM_DIALOG',
  /** A window of NEXUS's work took the foreground when it appeared. */
  'FOREGROUND_STEAL',
  /** A window of NEXUS's work came to the foreground later (most likely the owner chose it): recorded, not counted. */
  'FOCUSED_LATER',
  /** NEXUS's own confirmation, asked on purpose: recorded, not counted. */
  'NEXUS_CONFIRMATION',
] as const
export type DisturbanceKind = (typeof DISTURBANCE_KINDS)[number]

export interface DisturbanceEvent {
  at: string
  kind: DisturbanceKind
  /** The process that owned the window (its file name only), and the window's class. Never a title. */
  process: string
  windowClass: string
  runIds: string[]
}

/** Per mission (C17). Targets of a normal long mission: 0 everywhere, UAC exactly the prompts the owner chose. */
export interface UserDisturbanceMetrics {
  runId: string
  /** Whether the meter was running for this mission (on Windows, when its helper is part of the build). */
  measured: boolean
  uacPrompts: number
  visibleWindows: number
  foregroundSteals: number
  consoleFlashes: number
  unexpectedDialogs: number
  /** Not measured on this machine: toasts are not windows the meter can attribute. */
  notifications: null
  /** The most recent events, newest last. */
  recent: DisturbanceEvent[]
  /** Commands of a project that is not contained that were started on a desktop of their own (since NEXUS started). */
  quietCommands: number
}
