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
function Test-NexusRootState($State, [string]$MainUserSid, [string]$SandboxSid, [switch]$Strict) {
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
  return [pscustomobject]@{ Version = [string]$values.Version; AccountName = [string]$values.AccountName; AccountSid = [string]$values.AccountSid; Root = [string]$values.Root; Users = @([string[]]$values.Users) }
}
