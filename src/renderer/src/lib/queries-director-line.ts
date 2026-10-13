import type { QueryClient } from '@tanstack/react-query'
import type { DirectorLineView } from '@shared/ipc'
import { useRead, useWrite } from './queries'

/** 0.9 Director Line: the settings view and the actions on it. No secret is ever in what these return. */

export const qkDirectorLine = {
  root: () => ['directorLine'] as const,
  view: () => ['directorLine', 'view'] as const,
}

export const useDirectorLine = () => useRead(qkDirectorLine.view(), 'directorLine.get', {})

/** A write that answers with the view replaces the cached view at once. */
const replaceView = (qc: QueryClient, view: DirectorLineView): void => void qc.setQueryData(qkDirectorLine.view(), view)
const refresh = (qc: QueryClient): void => void qc.invalidateQueries({ queryKey: qkDirectorLine.root() })

// `silent`: the screen shows a declined confirmation or a refusal next to the control, not as a global toast.
export const useDirectorLineSetEnabled = () => useWrite('directorLine.setEnabled', replaceView, { silent: true })
export const useDirectorLineSetProvider = () => useWrite('directorLine.setProvider', replaceView, { silent: true })
export const useDirectorLineSetPolicy = () => useWrite('directorLine.setPolicy', replaceView, { silent: true })
export const useDirectorLineStartPairing = () => useWrite('directorLine.startPairing', undefined, { silent: true })
export const useDirectorLineSetPin = () => useWrite('directorLine.setPin', refresh, { silent: true })
export const useDirectorLineUnpair = () => useWrite('directorLine.unpair', refresh, { silent: true })
export const useDirectorLineTestMessage = () => useWrite('directorLine.sendTestMessage', refresh, { silent: true })
export const useDirectorLineSetSip = () => useWrite('directorLine.setSip', replaceView, { silent: true })
export const useDirectorLineRemoveSip = () => useWrite('directorLine.removeSip', replaceView, { silent: true })
export const useDirectorLineSetVoicePolicy = () => useWrite('directorLine.setVoicePolicy', replaceView, { silent: true })
export const useDirectorLineCallMe = () => useWrite('directorLine.callMe', refresh, { silent: true })
export const useDirectorLineHangUp = () => useWrite('directorLine.hangUpCall', replaceView, { silent: true })
