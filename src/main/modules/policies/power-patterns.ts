/**
 * The one source of the patterns that recognise machine power control (shutdown, restart, suspend, logoff).
 * Both the 0.2 command classifier and the 0.7 content inspector use these, so a name added here is refused
 * everywhere. Agents never control OS power: a hit is a refusal that cannot be approved.
 */

/** Win32/NT/WMI power APIs. A name may carry a suffix (InitiateSystemShutdownExW, SHExitWindowsEx), so no trailing boundary. */
const API_NAMES = String.raw`(?:shutdownwindows|win32shutdown|win32shutdowntracker|setsuspendstate|setsystempowerstate|exitwindowsex|shexitwindowsex|initiatesystemshutdown|initiateshutdown|ntshutdownsystem|ntinitiatepoweraction|ntsetsystempowerstate|ntpowerinformation|abortsystemshutdown|wtsshutdownsystem|wtslogoffsession|ntraiseharderror)`

/** Power APIs and WMI/CIM methods; plain command names are matched per segment instead. */
export const POWER_API_TEXT = new RegExp(
  [
    String.raw`\b${API_NAMES}\w*`,
    String.raw`powrprof(?:\.dll)?\s*,`,
    // rundll32 calling a user32/shell32/advapi32/kernel32 power export (SHExitWindowsEx, ExitWindowsEx, ...).
    String.raw`\brundll32(?:\.exe)?\b[^\n;|&]*?\b(?:user32|shell32|advapi32|kernel32|ntdll|powrprof|wtsapi32)(?:\.dll)?\s*,\s*#?\w*(?:shutdown|exitwindows|suspend|sleep|hibernate|reboot|logoff|poweroff)`,
    // The same through the generic method call of a WMI object: .InvokeMethod('Reboot', ...).
    String.raw`\binvokemethod\s*\(\s*['"](?:win32)?(?:shutdown|reboot|poweroff)\w*['"]`,
    // Looking the power executable up in order to run what is found (for /f ... in ('where shutdown') do ...).
    String.raw`\b(?:where(?:\.exe)?|get-command|gcm|which)\s+(?:-\w+\s+)*['"]?(?:shutdown|psshutdown\w*|stop-computer|restart-computer)\b`,
    String.raw`\binvoke-(?:wmi|cim)method\b[^|;&\n]*-(?:method)?name\s+['"]?(?:win32)?(?:shutdown|reboot)\b`,
    String.raw`\bsystemctl\s+(?:--?\S+\s+)*(?:poweroff|reboot|halt|suspend|hibernate|hybrid-sleep|kexec)\b`,
    String.raw`\bloginctl\s+(?:--?\S+\s+)*(?:poweroff|reboot|halt|suspend|hibernate)\b`,
  ].join('|'),
  'i',
)

const WMI_OBJECT = /\b(?:win32_operatingsystem|win32_computersystem|\[wmi\]|\[wmiclass\]|gwmi|get-wmiobject|get-ciminstance|wmiclass)\b/i
const WMI_POWER_METHOD = /\.\s*(?:shutdown|reboot|win32shutdown|win32shutdowntracker|poweroff)\s*\(/i

/** True when `text` names a power API, or calls .Shutdown()/.Reboot() on a WMI operating-system object. */
export function hasPowerApiText(text: string): boolean {
  return POWER_API_TEXT.test(text) || (WMI_OBJECT.test(text) && WMI_POWER_METHOD.test(text))
}

/** Executables that power off, restart, suspend or log off. Matched on the normalised base name. */
export const POWER_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'shutdown', 'psshutdown', 'psshutdown64', 'stop-computer', 'restart-computer', 'poweroff', 'halt', 'reboot', 'slidetoshutdown', 'telinit', 'tsshutdn', 'logoff', 'tsdiscon', 'rwinsta',
])

/** Power commands in the forms a script or command line uses them (matched on raw and squashed text). */
export const POWER_COMMAND_FORMS: readonly RegExp[] = [
  /\b(?:stop-computer|restart-computer|psshutdown\w*|tsshutdn|slidetoshutdown|tsdiscon|rwinsta)\b/i,
  /\breset(?:\.exe)?\s+session\b/i,
  // cmd.exe takes `/`, `,`, `=`, `;` and a quote as the end of the command name, so no space is needed before
  // the switch: `shutdown/s`, `shutdown.exe/r/t 0`, `shutdown"/s"`, `shutdown,/s`. A switch is one letter, which
  // keeps paths and identifiers (`shutdown/index.ts`, `shutdown-handler`) out.
  /\bshutdown(?:\.exe)?["']?[\s,;=]*["']?(?:[/-][a-z]{1,2}\b|--?(?:poweroff|reboot|halt|hibernate)\b|now\b)/i,
  /\bwmic(?:\.exe)?\b[^\n;|&]*\bos\b[^\n;|&]*\b(?:call\s+)?(?:win32)?(?:shutdown|reboot)\b/i,
  // A line that is a bare power command (a batch or shell script), not an identifier in program code.
  /^\s*(?:call\s+|start\s+(?:""\s+)?(?:\/\w+\s+)*)?(?:logoff|shutdown|poweroff|reboot|tsdiscon|rwinsta)(?:\.exe)?(?:[\s/,;="]|$)/im,
]

/** A power word that is only unambiguous next to something that starts a process. */
export const POWER_WORDS =
  /\b(?:shutdown(?:\.exe)?|poweroff|reboot|stop-computer|restart-computer|logoff|tsdiscon|psshutdown\w*|tsshutdn|slidetoshutdown|setsuspendstate|exitwindowsex|shexitwindowsex|initiatesystemshutdown\w*|initiateshutdown\w*|shutdownwindows|win32shutdown\w*|ntshutdownsystem)\b|powrprof/i

/** APIs and cmdlets that start another program; combined with a power word in the same text they are a refusal. */
export const EXEC_API =
  /start-process|\bsaps\b|\binvoke-expression\b|\biex\b|invoke-command|diagnostics\.process|processstartinfo|wscript\.shell|shell\.application|shellexecute|new-object\s+-com|\.run\s*\(|child_process|\bos\.(?:system|popen|exec\w*|spawn\w*)|subprocess|\bpopen\b|\bexec(?:sync|file|filesync)?\s*\(|\bspawn(?:sync)?\s*\(|\bsystem\s*\(|\bgettype\s*\(|\bproc_open|\bshell_exec|\bpassthru|runtime\.getruntime\(\)\.exec|\bexecvp?e?\s*\(|\bdeno\.(?:command|run)\b|\bexec\.command\(|\bprocessbuilder\b|\bprocess\.start\s*\(|\bwinexec\b|\bcreateprocess\w*\b|std::process::command|\bcommand::new\b|\[scriptblock\]::create|invokescript|\.invoke\s*\(|add-type|dllimport|ctypes|windll|\bffi\b|marshal\.getdelegateforfunctionpointer/i

/**
 * Patterns for NEXUS's own data and its runtime endpoint (the named pipe and its descriptor file).
 * 0.7.2: the stored ChatGPT credentials by their file name, and the variable that says where the data
 * directory is. A path can be built from that variable without spelling any of the names here.
 */
export const NEXUS_DATA_TEXT =
  /nexus\.db(?:-wal|-shm|-journal)?|overnight\.key|chatgpt-credentials|nexus_data_dir|runtime[\\/]+endpoint\.json|nexus[\\/]+runtime[\\/]|[\\/]runtime[\\/]+runtime\.log|nexus[\\/][^\s"']*runtime\.log|nexus-runtime|[\\/]pipe[\\/][^\n]*nexus|appdata%?\}?[\\/]+(?:(?:roaming|local)[\\/]+)?nexus(?![\w-])(?![\\/]+worktrees\b)/i
