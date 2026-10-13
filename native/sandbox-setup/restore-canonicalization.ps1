# NEXUS sandbox: the AppContainer's entry on the Mount Manager device. Runs elevated: once from the setup, and
# after every start of Windows from the startup task the setup registers (the entry is on a device object, and
# Windows makes that object anew at every start).
#
# Why. A program asks Windows for the canonical form of a path (GetFinalPathNameByHandle: Node's native
# realpath, Rust's canonicalize, the installer of Electron). Windows answers by asking the Mount Manager which
# drive letter a volume has. The Mount Manager device lets in Everyone, the system, administrators and
# restricted code, and no AppContainer: inside the isolated profile every such question is refused, for every
# path (measured). This gives NEXUS's own capability, and nothing else, what Everyone already has there: to
# open the device and ask. Not to read or write it: creating or deleting a mount point, changing a drive
# letter or the Mount Manager's database need read and write access to the device, which this does not give.
#
# What it does, and all it does: derives the capability's identifier from NEXUS's fixed name for it, reads the
# device's access list, adds one entry if it is not there, reads the list back, writes a result, ends. It takes
# no input that names what to change: no SID, no path, no command. -Check changes nothing; -Remove takes the
# entry away. It uses no network and starts no program.
[CmdletBinding()]
param(
  [string]$ResultFile = '',
  [switch]$Check,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
# The same name as in sandbox-checks.ps1 and in the launcher. A constant here, so that this file stands alone
# where the startup task runs it from.
$ContainerName = 'NexusSandbox.Contained.1'
# SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_EXECUTE | READ_CONTROL: FILE_GENERIC_EXECUTE, what Everyone has on this device.
$Mask = 0x001200A0
$result = [ordered]@{ ok = $false; changed = $false; present = $false; capabilitySid = $null; before = $null; after = $null; error = $null }

try {
  Add-Type -Namespace NexusBootstrap -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
[DllImport("ntdll.dll")] public static extern int NtQuerySecurityObject(IntPtr h, uint info, byte[] sd, uint length, out uint needed);
[DllImport("ntdll.dll")] public static extern int NtSetSecurityObject(IntPtr h, uint info, byte[] sd);
[DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groupSids, out uint groupCount, out IntPtr capabilitySids, out uint capabilityCount);
'@
  $groups = [IntPtr]::Zero; $caps = [IntPtr]::Zero; $groupCount = [uint32]0; $capCount = [uint32]0
  if (-not [NexusBootstrap.Native]::DeriveCapabilitySidsFromName($ContainerName, [ref]$groups, [ref]$groupCount, [ref]$caps, [ref]$capCount) -or $capCount -lt 1) { throw "Windows could not derive the capability's identifier." }
  $sid = New-Object Security.Principal.SecurityIdentifier([Runtime.InteropServices.Marshal]::ReadIntPtr($caps))
  if ($sid.Value -notmatch '^S-1-15-3-1024-[0-9-]+$') { throw "The capability's identifier is not one ($($sid.Value))." }
  $result.capabilitySid = $sid.Value

  # READ_CONTROL to look; WRITE_DAC as well only when something is to be changed.
  $access = if ($Check) { 0x00020000 } else { 0x00060000 }
  $handle = [NexusBootstrap.Native]::CreateFileW('\\.\MountPointManager', $access, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr](-1)) { throw "The Mount Manager device could not be opened ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))." }
  try {
    function Read-Descriptor {
      $buffer = New-Object byte[] 65536
      $needed = [uint32]0
      $status = [NexusBootstrap.Native]::NtQuerySecurityObject($handle, 0x4, $buffer, 65536, [ref]$needed)
      if ($status -ne 0) { throw ("The device's access list could not be read (0x{0:x})." -f $status) }
      return New-Object Security.AccessControl.RawSecurityDescriptor($buffer, 0)
    }
    function Find-Entries($descriptor) {
      $found = @()
      for ($i = 0; $i -lt $descriptor.DiscretionaryAcl.Count; $i++) {
        $ace = $descriptor.DiscretionaryAcl[$i]
        if ($ace -is [Security.AccessControl.CommonAce] -and $ace.SecurityIdentifier -eq $sid) { $found += $i }
      }
      return ,$found
    }
    $descriptor = Read-Descriptor
    $result.before = $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
    if ($null -eq $descriptor.DiscretionaryAcl) { throw 'The device has no access list to add to.' }
    $entries = Find-Entries $descriptor
    # Exactly the entry this script makes: one, allowing, with this mask, not inherited.
    $asIntended = ($entries.Count -eq 1) -and ($descriptor.DiscretionaryAcl[$entries[0]].AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed) -and ($descriptor.DiscretionaryAcl[$entries[0]].AccessMask -eq $Mask)
    $wanted = -not $Remove
    if (-not $Check -and (($wanted -and -not $asIntended) -or (-not $wanted -and $entries.Count -gt 0))) {
      # Entries for this capability that are not the intended one go; nobody else's entry is touched.
      foreach ($i in ($entries | Sort-Object -Descending)) { $descriptor.DiscretionaryAcl.RemoveAce($i) }
      if ($wanted) {
        $ace = New-Object Security.AccessControl.CommonAce([Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessAllowed, $Mask, $sid, $false, $null)
        $descriptor.DiscretionaryAcl.InsertAce($descriptor.DiscretionaryAcl.Count, $ace)
      }
      $bytes = New-Object byte[] $descriptor.BinaryLength
      $descriptor.GetBinaryForm($bytes, 0)
      $status = [NexusBootstrap.Native]::NtSetSecurityObject($handle, 0x4, $bytes)
      if ($status -ne 0) { throw ("The device's access list could not be set (0x{0:x})." -f $status) }
      $result.changed = $true
    }
    $after = Read-Descriptor
    $result.after = $after.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $now = Find-Entries $after
    $result.present = ($now.Count -eq 1) -and ($after.DiscretionaryAcl[$now[0]].AccessMask -eq $Mask) -and ($after.DiscretionaryAcl[$now[0]].AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed)
    if (-not $Check -and $wanted -and -not $result.present) { throw 'The entry is not there after it was set.' }
    if (-not $Check -and -not $wanted -and $now.Count -gt 0) { throw 'The entry is still there after it was removed.' }
    $result.ok = $true
  } finally { [void][NexusBootstrap.Native]::CloseHandle($handle) }
} catch {
  $result.error = $_.Exception.Message
}
$json = $result | ConvertTo-Json -Depth 3 -Compress
if ($ResultFile) { try { Set-Content -LiteralPath $ResultFile -Value $json -Encoding UTF8 } catch { } }
$json
if ($result.ok) { exit 0 } else { exit 1 }
