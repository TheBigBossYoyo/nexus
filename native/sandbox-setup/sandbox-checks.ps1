# NEXUS sandbox account: the checks shared by the setup (elevated) and the verification (not elevated).
#
# Nothing here trusts a name. An account called NexusSandbox, a folder called C:\ProgramData\NexusSandbox and a
# firewall rule called NexusSandbox-Block-Outbound may each have been made by somebody else, for another
# purpose or on purpose. Each function looks at what the thing IS and returns a list of problems, empty when
# it is what NEXUS needs. The callers decide: the setup repairs what is its own to repair and stops at the
# rest; the verification reports.
#
# Dot-source this file. It changes nothing on the machine.

$script:NexusSandboxMarker = 'NEXUS sandbox account v1'
# The description the first version of the setup gave the account. Only an administrator can set it.
$script:NexusSandboxMarkerLegacy = 'NEXUS: contained project code runs here'
$script:NexusSandboxKey = 'HKLM:\SOFTWARE\NexusSandbox'
# The cmdlets used here and by the scripts that load this file (local accounts, firewall, access lists) are
# taken from Windows' own module folder and from nowhere else: the module path a user's environment names
# begins with a folder in the user's documents, and the setup runs elevated.
$env:PSModulePath = Join-Path $PSHOME 'Modules'

# A build of 0.8 before its release tried an RPC filter to keep the account from the DNS Client service (it did
# not: measured). A machine set up by that build still has the filter; the removal takes it away by its key.
$script:NexusDnsFilterKey = '6e455855-0800-4d4e-9f80-0000000d0001'

function Remove-NexusDnsFilter {
  $file = Join-Path ([IO.Path]::GetTempPath()) ("nexus-rpc-{0}.txt" -f ([guid]::NewGuid().ToString('N')))
  try {
    Set-Content -LiteralPath $file -Value @('rpc filter', "delete filter filterkey=$($script:NexusDnsFilterKey)") -Encoding ASCII
    [void]((& (Join-Path $env:SystemRoot 'System32\netsh.exe') -f $file 2>&1) | Out-String)
  } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}

# The AppContainer contained commands are started in (0.8): a name, from which Windows derives a SID that is the
# same on every machine, and a capability of NEXUS's own of the same name, which is all the AppContainer holds and
# which Windows gives no meaning. The launcher derives the same two SIDs from the same name.
#
# Folders are opened to the capability, never to the AppContainer itself: an access list that names an
# AppContainer keeps every low-integrity program out of the folder (measured on the drive's root: nothing at low
# integrity could open "C:\" any more), and one that names a capability does not. Windows' own entry on the
# drive's root is for a capability too.
$script:NexusAppContainerName = 'NexusSandbox.Contained.1'

function Get-NexusAppContainerSid {
  if (-not ('NexusSandbox.Native' -as [type])) {
    Add-Type -Namespace NexusSandbox -Name Native -MemberDefinition @'
[DllImport("userenv.dll", CharSet = CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
[DllImport("advapi32.dll")] public static extern IntPtr FreeSid(IntPtr sid);
[DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groupSids, out uint groupCount, out IntPtr capabilitySids, out uint capabilityCount);
'@
  }
  $pointer = [IntPtr]::Zero
  $hr = [NexusSandbox.Native]::DeriveAppContainerSidFromAppContainerName($script:NexusAppContainerName, [ref]$pointer)
  if ($hr -ne 0 -or $pointer -eq [IntPtr]::Zero) { throw ("Windows could not derive the AppContainer's identifier (0x{0:x})." -f $hr) }
  try { $sid = (New-Object Security.Principal.SecurityIdentifier($pointer)).Value } finally { [void][NexusSandbox.Native]::FreeSid($pointer) }
  if ($sid -notmatch '^S-1-15-2-[0-9-]+$') { throw "The AppContainer's identifier is not one ($sid)." }
  return $sid
}

function Get-NexusCapabilitySid {
  [void](Get-NexusAppContainerSid)
  $groups = [IntPtr]::Zero; $caps = [IntPtr]::Zero; $groupCount = [uint32]0; $capCount = [uint32]0
  if (-not [NexusSandbox.Native]::DeriveCapabilitySidsFromName($script:NexusAppContainerName, [ref]$groups, [ref]$groupCount, [ref]$caps, [ref]$capCount) -or $capCount -lt 1) { throw "Windows could not derive the capability's identifier." }
  $sid = (New-Object Security.Principal.SecurityIdentifier([Runtime.InteropServices.Marshal]::ReadIntPtr($caps))).Value
  if ($sid -notmatch '^S-1-15-3-1024-[0-9-]+$') { throw "The capability's identifier is not one ($sid)." }
  return $sid
}

# The two folders above the sandbox root: the drive's root and ProgramData. A process in an AppContainer is let
# into a folder only where the AppContainer itself has an entry, whatever the account may do, and Windows gives
# AppContainers none on these two (the entry is for NEXUS's capability, see above). Without one a contained program cannot even ask whether "C:\" exists, and
# cmd, Node and git all ask (measured: "access denied", "EPERM lstat 'C:\'", "unable to get current working
# directory"). The entry is for the folder itself and is inherited by nothing in it: to read and list that one
# folder, which the sandbox account may do already as a member of Users.
function Get-NexusAncestorFolders([string]$Root) {
  $full = [IO.Path]::GetFullPath($Root)
  $parent = Split-Path -Parent $full
  $drive = [IO.Path]::GetPathRoot($full)
  return @($drive, $parent)
}

# The entries one SID has on a folder itself, as plain values.
function Get-NexusOwnEntries([string]$Path, [string]$Sid) {
  $acl = Get-Acl -LiteralPath $Path
  return @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $Sid } | ForEach-Object { [pscustomobject]@{ Rights = [string]$_.FileSystemRights; Type = [string]$_.AccessControlType; Inheritance = [string]$_.InheritanceFlags } })
}

# Is the AppContainer's entry on an ancestor folder exactly the one the setup makes: read and list, this folder only?
function Test-NexusAncestorEntry($Entries) {
  $list = @($Entries | Where-Object { $null -ne $_ })
  if ($list.Count -eq 0) { return @("the sandbox's capability has no entry there") }
  $problems = @()
  foreach ($entry in $list) {
    if ($entry.Type -ne 'Allow' -or $entry.Rights -ne 'ReadAndExecute, Synchronize' -or $entry.Inheritance -ne 'None') { $problems += "the capability's entry there is $($entry.Type) $($entry.Rights), inherited by $($entry.Inheritance)" }
  }
  return $problems
}

function Invoke-NexusIcacls([string[]]$Arguments) {
  $out = (& (Join-Path $env:SystemRoot 'System32\icacls.exe') @Arguments 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "icacls $($Arguments -join ' '): $($out.Trim())" }
}

# The startup task that restores the AppContainer's entry on the Mount Manager device after a restart of
# Windows (restore-canonicalization.ps1), and where its script lies: a folder only administrators write.
$script:NexusBootstrapTask = 'NexusSandbox-RestoreCanonicalization'
function Get-NexusBootstrapDir { return (Join-Path $env:ProgramFiles 'NexusSandbox') }

$script:UsersSid = 'S-1-5-32-545'
$script:AdminsSid = 'S-1-5-32-544'
$script:SystemSid = 'S-1-5-18'

function Test-NexusReparsePoint([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# The account as an object of plain values, so that the judgement below can be tested without an account.
function Get-NexusAccountState([string]$AccountName) {
  $user = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  if ($null -eq $user) { return $null }
  $sid = $user.SID.Value
  $groups = @(); $unread = @()
  foreach ($group in Get-LocalGroup) {
    # A group whose members cannot be listed (Windows PowerShell fails on a group that holds an account that no
    # longer exists) is not a group the account is known to be out of: it is reported, not passed over.
    $failed = $null
    $members = @(Get-LocalGroupMember -Group $group -ErrorAction SilentlyContinue -ErrorVariable failed | Where-Object { $_.SID.Value -eq $sid })
    if ($failed -and $failed.Count -gt 0) { $unread += $group.SID.Value }
    if ($members.Count -gt 0) { $groups += $group.SID.Value }
  }
  return [pscustomobject]@{ Name = $user.Name; Sid = $sid; Enabled = [bool]$user.Enabled; Description = [string]$user.Description; PrincipalSource = [string]$user.PrincipalSource; Groups = $groups; UnreadGroups = $unread }
}

# Is this account one that NEXUS's setup made, and is it only what that setup makes it?
# Returns @{ Ours = <bool>; Problems = <string[]>; Repairable = <string[]> }.
function Test-NexusAccountState($State) {
  $problems = @(); $repairable = @()
  if ($null -eq $State) { return @{ Ours = $false; Problems = @('no such account'); Repairable = @() } }
  $ours = ($State.Description -eq $script:NexusSandboxMarker) -or ($State.Description -eq $script:NexusSandboxMarkerLegacy)
  if (-not $ours) { $problems += "an account named $($State.Name) exists and does not carry the mark of NEXUS's setup (its description is '$($State.Description)')" }
  if ($State.PrincipalSource -ne 'Local') { $problems += "the account is not a local account ($($State.PrincipalSource))" }
  if ($State.Sid -notmatch '^S-1-5-21-[0-9-]+-[0-9]{4,}$') { $problems += 'the account is not an ordinary local user (its identifier is not one)' }
  foreach ($group in @($State.UnreadGroups)) {
    if ($null -ne $group) { $problems += "the members of the group $group could not be listed, so it is not known whether the account is in it" }
  }
  foreach ($group in $State.Groups) {
    if ($group -ne $script:UsersSid) {
      if ($ours) { $repairable += "member of the group $group" } else { $problems += "member of the group $group" }
    }
  }
  if ($State.Groups -notcontains $script:UsersSid) { $repairable += 'not a member of Users' }
  if (-not $State.Enabled) { $repairable += 'disabled' }
  if ($ours -and $State.Description -ne $script:NexusSandboxMarker) { $repairable += 'carries the mark of an earlier setup' }
  return @{ Ours = $ours; Problems = $problems; Repairable = $repairable }
}

# The folder as plain values.
function Get-NexusRootState([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $item = Get-Item -LiteralPath $Path -Force
  $acl = Get-Acl -LiteralPath $Path
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ Sid = $_.IdentityReference.Value; Rights = [string]$_.FileSystemRights; Type = [string]$_.AccessControlType; Inherited = [bool]$_.IsInherited } })
  $children = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $owner = $null
    try { $owner = (Get-Acl -LiteralPath $_.FullName).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { }
    [pscustomobject]@{ Name = $_.Name; Reparse = [bool]($_.Attributes -band [IO.FileAttributes]::ReparsePoint); Owner = $owner }
  })
  return [pscustomobject]@{
    Path = $item.FullName
    IsDirectory = [bool]$item.PSIsContainer
    Reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    Owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    Protected = [bool]$acl.AreAccessRulesProtected
    Rules = $rules
    Children = $children
  }
}

# Can this existing folder be taken as the sandbox root? Who may own it: the user NEXUS runs as, the
# administrators, the system. Another owner means somebody else made it, and it is left alone.
# With -Strict, the access list must already be exactly the one the setup writes (the verification's question).
function Test-NexusRootState($State, [string]$MainUserSid, [string]$SandboxSid, [switch]$Strict, [string]$AppContainerSid = '') {
  $problems = @(); $repairable = @()
  if ($null -eq $State) { return @{ Problems = @(); Repairable = @('does not exist') } }
  if (-not $State.IsDirectory) { $problems += 'it is not a folder' }
  if ($State.Reparse) { $problems += 'it is a link to another place (a junction or a symbolic link)' }
  $trustedOwners = @($MainUserSid, $script:AdminsSid, $script:SystemSid)
  if ($trustedOwners -notcontains $State.Owner) { $problems += "it belongs to somebody else (owner $($State.Owner))" }
  $knownOwners = $trustedOwners + @($SandboxSid)
  foreach ($child in $State.Children) {
    if ($child.Reparse) { $problems += "it contains a link to another place: $($child.Name)" }
    elseif ($null -ne $child.Owner -and $knownOwners -notcontains $child.Owner) { $problems += "it contains an entry that belongs to somebody else: $($child.Name) (owner $($child.Owner))" }
  }
  $expected = @{ $script:SystemSid = 'FullControl'; $script:AdminsSid = 'FullControl'; $MainUserSid = 'FullControl' }
  if ($SandboxSid) { $expected[$SandboxSid] = 'Modify, Synchronize' }
  # In an AppContainer both must be let in: the account and the AppContainer, here by its capability. To read
  # only: NEXUS gives the capability the right to write on the directories of a session, one by one. (Without a
  # capability's entry an AppContainer writes nowhere, and where it has one no integrity label is needed for it
  # to write: so the entry of the root must not be one to write.)
  if ($AppContainerSid) { $expected[$AppContainerSid] = 'ReadAndExecute, Synchronize' }
  $extra = @($State.Rules | Where-Object { -not $expected.ContainsKey($_.Sid) -or $_.Type -ne 'Allow' })
  $wrong = @($State.Rules | Where-Object { $expected.ContainsKey($_.Sid) -and $_.Type -eq 'Allow' -and ($_.Rights -ne $expected[$_.Sid]) })
  $missing = @($expected.Keys | Where-Object { $sid = $_; @($State.Rules | Where-Object { $_.Sid -eq $sid -and $_.Type -eq 'Allow' }).Count -eq 0 })
  $aclOff = (-not $State.Protected) -or $extra.Count -gt 0 -or $wrong.Count -gt 0 -or $missing.Count -gt 0 -or ($State.Owner -ne $MainUserSid)
  if ($aclOff) {
    $what = @()
    if (-not $State.Protected) { $what += 'its access list is inherited' }
    foreach ($rule in $extra) { $what += "access for $($rule.Sid) ($($rule.Type) $($rule.Rights))" }
    foreach ($rule in $wrong) { $what += "access for $($rule.Sid) is $($rule.Rights)" }
    foreach ($sid in $missing) { $what += "no access for $sid" }
    if ($State.Owner -ne $MainUserSid -and $trustedOwners -contains $State.Owner) { $what += "owner is $($State.Owner)" }
    if ($Strict) { $problems += $what } else { $repairable += $what }
  }
  return @{ Problems = $problems; Repairable = $repairable }
}

# A firewall rule as plain values, or $null.
function Get-NexusFirewallRuleState([string]$Name) {
  $rule = Get-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $rule) { return $null }
  $security = $rule | Get-NetFirewallSecurityFilter
  $address = $rule | Get-NetFirewallAddressFilter
  $port = $rule | Get-NetFirewallPortFilter
  $app = $rule | Get-NetFirewallApplicationFilter
  return [pscustomobject]@{
    Name = $rule.Name; Enabled = [string]$rule.Enabled; Action = [string]$rule.Action; Direction = [string]$rule.Direction; Profile = [string]$rule.Profile
    LocalUser = [string]$security.LocalUser; RemoteAddress = [string](@($address.RemoteAddress) -join ','); LocalAddress = [string](@($address.LocalAddress) -join ',')
    Protocol = [string]$port.Protocol; RemotePort = [string](@($port.RemotePort) -join ','); LocalPort = [string](@($port.LocalPort) -join ','); Program = [string]$app.Program
  }
}

# Does the rule block everything of that account, in that direction, on every profile, and nothing narrower?
function Test-NexusFirewallRuleState($State, [string]$Direction, [string]$SandboxSid) {
  if ($null -eq $State) { return @('there is no such rule') }
  $problems = @()
  if ($State.Enabled -ne 'True') { $problems += 'it is not enabled' }
  if ($State.Action -ne 'Block') { $problems += "its action is $($State.Action)" }
  if ($State.Direction -ne $Direction) { $problems += "its direction is $($State.Direction)" }
  if ($State.Profile -ne 'Any') { $problems += "it applies to the profiles $($State.Profile) only" }
  if ($State.LocalUser -ne "D:(A;;CC;;;$SandboxSid)") { $problems += "it is not for the sandbox account alone ($($State.LocalUser))" }
  foreach ($pair in @(@('RemoteAddress', $State.RemoteAddress), @('LocalAddress', $State.LocalAddress), @('Protocol', $State.Protocol), @('RemotePort', $State.RemotePort), @('LocalPort', $State.LocalPort), @('Program', $State.Program))) {
    if ($pair[1] -ne 'Any' -and $pair[1] -ne '') { $problems += "it is narrowed by $($pair[0]): $($pair[1])" }
  }
  return $problems
}

# What the setup recorded where only an administrator writes: which account and which folder are NEXUS's.
function Get-NexusSandboxRecord {
  if (-not (Test-Path $script:NexusSandboxKey)) { return $null }
  $values = Get-ItemProperty -Path $script:NexusSandboxKey
  return [pscustomobject]@{ Version = [string]$values.Version; AccountName = [string]$values.AccountName; AccountSid = [string]$values.AccountSid; Root = [string]$values.Root; Users = @([string[]]$values.Users); AppContainerName = [string]$values.AppContainerName; AppContainerSid = [string]$values.AppContainerSid; CapabilitySid = [string]$values.CapabilitySid }
}
