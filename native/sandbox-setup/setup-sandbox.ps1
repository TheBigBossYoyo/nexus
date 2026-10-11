# NEXUS sandbox account: one-time setup. Runs elevated, once per machine, after the user agreed to it.
#
# What it does, all of it reversible with remove-sandbox.ps1:
#   1. creates the local standard account "NexusSandbox" (or resets its password when it exists) and hides it
#      from the sign-in screen;
#   2. blocks outbound and inbound network traffic of that account in Windows Firewall. Loopback is not
#      filtered by Windows Firewall, so the account can still reach NEXUS's own proxy on 127.0.0.1, which is
#      the only way out it is meant to have;
#   3. creates the sandbox root (default C:\ProgramData\NexusSandbox) readable and writable by the user who
#      runs NEXUS and by the sandbox account, and by nobody else but SYSTEM and administrators.
#
# What it does not do: it changes no file or setting of the user's own profile, installs no service, and
# gives the account no group but Users. It writes its result as JSON to -ResultFile.
#
# The password is read from -PasswordFile (written by NEXUS for this run, readable by the user only) and is
# never printed, logged or put on a command line.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$MainUserSid,
  [Parameter(Mandatory = $true)][string]$PasswordFile,
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [string]$AccountName = 'NexusSandbox',
  [string]$SandboxRoot = 'C:\ProgramData\NexusSandbox'
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{ ok = $false; account = $AccountName; sid = $null; root = $SandboxRoot; firewallOutbound = $false; firewallInbound = $false; hidden = $false; steps = @(); error = $null }

function Step([string]$name) { $script:result.steps += $name }

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'This setup must run elevated.' }
  if ($MainUserSid -notmatch '^S-1-5-21-[0-9-]+$') { throw 'MainUserSid is not a user SID.' }
  if ($AccountName -notmatch '^[A-Za-z][A-Za-z0-9]{2,19}$') { throw 'AccountName must be 3 to 20 letters and digits.' }
  $full = [IO.Path]::GetFullPath($SandboxRoot)
  if ($full -notmatch '^[A-Za-z]:\\ProgramData\\[A-Za-z0-9_-]+$') { throw 'SandboxRoot must be a folder directly under ProgramData.' }

  $plain = (Get-Content -LiteralPath $PasswordFile -Raw -Encoding UTF8).Trim()
  if ($plain.Length -lt 24) { throw 'The password file does not hold a password of the expected length.' }
  $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
  $plain = $null

  # 1. The account.
  $existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    New-LocalUser -Name $AccountName -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description 'NEXUS: contained project code runs here' | Out-Null
    Step 'account-created'
  } else {
    Set-LocalUser -Name $AccountName -Password $secure -PasswordNeverExpires $true -UserMayChangePassword $false
    Enable-LocalUser -Name $AccountName
    Step 'account-password-reset'
  }
  $sid = (Get-LocalUser -Name $AccountName).SID.Value
  $result.sid = $sid
  # Users: the right to log on, and read access to Program Files. No other group.
  $usersGroup = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
  $isMember = @(Get-LocalGroupMember -Group $usersGroup -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $sid }).Count -gt 0
  if (-not $isMember) { Add-LocalGroupMember -Group $usersGroup -Member $AccountName; Step 'added-to-users' }

  # Not on the sign-in screen: nobody logs on to it by hand.
  $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name $AccountName -PropertyType DWord -Value 0 -Force | Out-Null
  $result.hidden = $true
  Step 'hidden-from-sign-in'

  # 2. The firewall: nothing in or out for this account, on every profile.
  $sddl = "D:(A;;CC;;;$sid)"
  foreach ($direction in @('Outbound', 'Inbound')) {
    $name = "NexusSandbox-Block-$direction"
    Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    try {
      New-NetFirewallRule -Name $name -DisplayName "NEXUS sandbox account: block $($direction.ToLower())" -Description 'Contained project code reaches the network only through the NEXUS proxy on the loopback.' -Direction $direction -Action Block -LocalUser $sddl -Profile Any -Enabled True | Out-Null
      if ($direction -eq 'Outbound') { $result.firewallOutbound = $true } else { $result.firewallInbound = $true }
      Step "firewall-$($direction.ToLower())"
    } catch {
      Step "firewall-$($direction.ToLower())-failed: $($_.Exception.Message)"
    }
  }
  if (-not $result.firewallOutbound) { throw 'The outbound firewall rule could not be created. Without it the account is not contained.' }

  # 3. The sandbox root.
  if (-not (Test-Path -LiteralPath $full)) { New-Item -ItemType Directory -Path $full | Out-Null; Step 'root-created' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $none = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @($MainUserSid, 'FullControl'), @($sid, 'Modify'))) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($entry[0])), [Security.AccessControl.FileSystemRights]$entry[1], $inherit, $none, $allow)
    $acl.AddAccessRule($rule)
  }
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($MainUserSid)))
  Set-Acl -LiteralPath $full -AclObject $acl
  Step 'root-acl'

  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
} finally {
  $secure = $null
  try { ($result | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $ResultFile -Encoding UTF8 } catch { }
}
if ($result.ok) { exit 0 } else { exit 1 }
