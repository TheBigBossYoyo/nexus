/**
 * WLAN reason codes (wlanapi.h, WLAN_REASON_CODE_*) that matter to an outage record, and who started a
 * disconnect. The numbers come from the Windows SDK header; which of them Windows reports for a disconnect the
 * user asked for was NOT confirmed on this machine (docs/NETWORK_RESILIENCE.md), so the table errs towards
 * "respect it": a missed reconnect costs a wait, a reconnect against the user's wish costs trust.
 */

const MSM_BASE = 0x00038000
const ACM_BASE = 0x00030000

const NAMES = new Map<number, string>([
  [0x00000000, 'WLAN_REASON_CODE_SUCCESS'],
  [0x00010001, 'WLAN_REASON_CODE_UNKNOWN'],
  [ACM_BASE + 1, 'WLAN_REASON_CODE_NETWORK_NOT_COMPATIBLE'],
  [ACM_BASE + 2, 'WLAN_REASON_CODE_PROFILE_NOT_COMPATIBLE'],
  [MSM_BASE + 1, 'WLAN_REASON_CODE_NO_AUTO_CONNECTION'],
  [MSM_BASE + 2, 'WLAN_REASON_CODE_NOT_VISIBLE'],
  [MSM_BASE + 3, 'WLAN_REASON_CODE_GP_DENIED'],
  [MSM_BASE + 4, 'WLAN_REASON_CODE_USER_DENIED'],
  [MSM_BASE + 5, 'WLAN_REASON_CODE_BSS_TYPE_NOT_ALLOWED'],
  [MSM_BASE + 6, 'WLAN_REASON_CODE_IN_FAILED_LIST'],
  [MSM_BASE + 7, 'WLAN_REASON_CODE_IN_BLOCKED_LIST'],
  [MSM_BASE + 8, 'WLAN_REASON_CODE_SSID_LIST_TOO_LONG'],
  [MSM_BASE + 9, 'WLAN_REASON_CODE_CONNECT_CALL_FAIL'],
  [MSM_BASE + 10, 'WLAN_REASON_CODE_SCAN_CALL_FAIL'],
  [MSM_BASE + 11, 'WLAN_REASON_CODE_NETWORK_NOT_AVAILABLE'],
  [MSM_BASE + 12, 'WLAN_REASON_CODE_PROFILE_CHANGED_OR_DELETED'],
  [MSM_BASE + 13, 'WLAN_REASON_CODE_KEY_MISMATCH'],
  [MSM_BASE + 14, 'WLAN_REASON_CODE_USER_NOT_RESPOND'],
])

export function reasonCodeName(code: number): string {
  return NAMES.get(code) ?? `0x${(code >>> 0).toString(16).padStart(8, '0')}`
}

export type DisconnectInitiator = 'USER' | 'SYSTEM' | 'UNKNOWN'

/**
 * Who asked for a disconnect, from its reason code. USER: a completed deliberate request (code 0, which is what
 * WlanDisconnect reports) or the user's own refusal (USER_DENIED, USER_NOT_RESPOND). SYSTEM: Windows lost or
 * refused the network (not visible, not available, key mismatch, blocked, failed list). UNKNOWN: no code, or
 * one this table does not know; recovery treats UNKNOWN as "not the user's", after a grace period.
 */
export function disconnectInitiator(code: number | null): DisconnectInitiator {
  if (code === null) return 'UNKNOWN'
  if (code === 0 || code === MSM_BASE + 4 || code === MSM_BASE + 14) return 'USER'
  if (NAMES.has(code)) return 'SYSTEM'
  return 'UNKNOWN'
}
