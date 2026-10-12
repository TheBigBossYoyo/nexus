# NEXUS sandbox account: one-time setup. Runs elevated, once per machine, after the user agreed to it.
#
# What it does, all of it reversible with remove-sandbox.ps1:
#   1. creates the local standard account "NexusSandbox", or takes up again one that an earlier run of this
#      setup made, and hides it from the sign-in screen;
#   2. blocks outbound and inbound network traffic of that account in Windows Firewall. Loopback is not
#      filtered by Windows Firewall, so the account can still reach NEXUS's own proxy on 127.0.0.1, which is
#      the only way out it is meant to have;
#   3. creates the sandbox root (default C:\ProgramData\NexusSandbox) readable and writable by the user who
#      runs NEXUS and by the sandbox account, and by nobody else but SYSTEM and administrators;
#   4. lets the AppContainer NEXUS starts contained commands in (a fixed name; it holds one capability of
#      NEXUS's own and none of Windows': Windows looks up no name for it and lets none of its packets out) read
#      the sandbox root, and gives that capability an entry on the two folders above the root, the drive's root
#      and ProgramData: to read and list that folder itself, inherited by nothing in it. Without these a program
#      in the AppContainer cannot find its own working directory. The entries name the capability, not the
#      AppContainer: an entry for an AppContainer keeps low-integrity programs out of the folder;
#   5. records, in HKLM where only an administrator writes, which account, folder and AppContainer are NEXUS's.
#
# It trusts no name. An account, a folder or a firewall rule that is already there under the expected name is
# looked at (sandbox-checks.ps1). What this setup made before is repaired to what it should be. What it did not
# make is left exactly as it is, and the setup stops and says why: it does not take over somebody else's
# account, does not write into somebody else's folder, and deletes nothing it did not create.
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
. (Join-Path $PSScriptRoot 'sandbox-checks.ps1')
$result = [ordered]@{ ok = $false; account = $AccountName; sid = $null; root = $SandboxRoot; firewallOutbound = $false; firewallInbound = $false; hidden = $false; appContainer = $null; appContainerSid = $null; capabilitySid = $null; loopbackExempt = $null; steps = @(); error = $null }

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

  # 0. Everything that is already there is looked at before anything is changed. One refusal, and nothing was touched.
  $account = Get-NexusAccountState $AccountName
  $accountCheck = $null
  if ($null -ne $account) {
    $accountCheck = Test-NexusAccountState $account
    if ($accountCheck.Problems.Count -gt 0) { throw "The account $AccountName cannot be used and was not changed: $($accountCheck.Problems -join '; '). Remove or rename it, or run the setup with another account name." }
  }
  $containerSid = Get-NexusAppContainerSid
  $capabilitySid = Get-NexusCapabilitySid
  $root = Get-NexusRootState $full
  if ($null -ne $root) {
    # An entry for the AppContainer itself, which a pre-release build of 0.8 made, is that build's and is replaced below.
    $root.Rules = @($root.Rules | Where-Object { $_.Sid -ne $containerSid })
    $rootCheck = Test-NexusRootState $root $MainUserSid $(if ($null -ne $account) { $account.Sid } else { '' }) -AppContainerSid $capabilitySid
    if ($rootCheck.Problems.Count -gt 0) { throw "The folder $full cannot be used and was not changed: $($rootCheck.Problems -join '; '). Move it away, or run the setup with another folder." }
  }
  $record = Get-NexusSandboxRecord
  if ($null -ne $record -and $null -ne $account -and $record.AccountSid -and $record.AccountSid -ne $account.Sid) {
    throw "The machine's record of the sandbox account names another account ($($record.AccountSid)) than the one called $AccountName now ($($account.Sid)). Nothing was changed."
  }

  # 1. The account.
  if ($null -eq $account) {
    New-LocalUser -Name $AccountName -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description $script:NexusSandboxMarker | Out-Null
    Step 'account-created'
  } else {
    # One this setup made before: its password is set anew, and it is put back to what the setup makes it.
    Set-LocalUser -Name $AccountName -Password $secure -PasswordNeverExpires $true -UserMayChangePassword $false -Description $script:NexusSandboxMarker
    Enable-LocalUser -Name $AccountName
    Step 'account-password-reset'
    foreach ($group in $account.Groups) {
      if ($group -ne $script:UsersSid) {
        Remove-LocalGroupMember -SID $group -Member $account.Sid
        Step "removed-from-group-$group"
      }
    }
  }
  $sid = (Get-LocalUser -Name $AccountName).SID.Value
  $result.sid = $sid
  # Users: the right to log on, and read access to Program Files. No other group.
  $isMember = @(Get-LocalGroupMember -SID $script:UsersSid -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $sid }).Count -gt 0
  if (-not $isMember) { Add-LocalGroupMember -SID $script:UsersSid -Member $sid; Step 'added-to-users' }
  $after = Test-NexusAccountState (Get-NexusAccountState $AccountName)
  if ($after.Problems.Count -gt 0 -or $after.Repairable.Count -gt 0) { throw "The account is not what the setup makes it: $(($after.Problems + $after.Repairable) -join '; ')." }

  # Not on the sign-in screen: nobody logs on to it by hand.
  $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name $AccountName -PropertyType DWord -Value 0 -Force | Out-Null
  $result.hidden = $true
  Step 'hidden-from-sign-in'

  # 2. The firewall: nothing in or out for this account, on every profile. A rule of that name is this setup's
  # by its name alone only as far as replacing it goes; what is kept is what is read back afterwards.
  $sddl = "D:(A;;CC;;;$sid)"
  foreach ($direction in @('Outbound', 'Inbound')) {
    $name = "NexusSandbox-Block-$direction"
    Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    try {
      New-NetFirewallRule -Name $name -DisplayName "NEXUS sandbox account: block $($direction.ToLower())" -Description 'Contained project code reaches the network only through the NEXUS proxy on the loopback.' -Direction $direction -Action Block -LocalUser $sddl -Profile Any -Enabled True | Out-Null
      $wrong = Test-NexusFirewallRuleState (Get-NexusFirewallRuleState $name) $direction $sid
      if ($wrong.Count -gt 0) { throw "the rule is not what was asked for: $($wrong -join '; ')" }
      if ($direction -eq 'Outbound') { $result.firewallOutbound = $true } else { $result.firewallInbound = $true }
      Step "firewall-$($direction.ToLower())"
    } catch {
      Step "firewall-$($direction.ToLower())-failed: $($_.Exception.Message)"
    }
  }
  if (-not $result.firewallOutbound) { throw 'The outbound firewall rule could not be created. Without it the account is not contained.' }

  # 3. The sandbox root. An existing one passed the checks above: it is a real folder of the user's, the
  # administrators' or the system's, with nothing of anybody else's in it.
  if (-not (Test-Path -LiteralPath $full)) { New-Item -ItemType Directory -Path $full | Out-Null; Step 'root-created' }
  if (Test-NexusReparsePoint $full) { throw "The folder $full became a link while the setup ran. Nothing more was changed." }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $none = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @($MainUserSid, 'FullControl'), @($sid, 'Modify'), @($capabilitySid, 'ReadAndExecute'))) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($entry[0])), [Security.AccessControl.FileSystemRights]$entry[1], $inherit, $none, $allow)
    $acl.AddAccessRule($rule)
  }
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($MainUserSid)))
  Set-Acl -LiteralPath $full -AclObject $acl
  Step 'root-acl'
  $rootAfter = Test-NexusRootState (Get-NexusRootState $full) $MainUserSid $sid -Strict -AppContainerSid $capabilitySid
  if ($rootAfter.Problems.Count -gt 0) { throw "The folder $full is not what the setup makes it: $($rootAfter.Problems -join '; ')." }

  # 4. The capability on the two folders above the root. One entry each, added to the list that is there:
  # nothing else in those lists is read into a new one or written back, and nothing below inherits it.
  $result.appContainer = $script:NexusAppContainerName
  $result.appContainerSid = $containerSid
  $result.capabilitySid = $capabilitySid
  foreach ($folder in (Get-NexusAncestorFolders $full)) {
    if (Test-NexusReparsePoint $folder) { throw "The folder $folder is a link to another place. Nothing more was changed." }
    # First of all: an entry for the AppContainer itself, which a pre-release build of 0.8 made here, is taken
    # away. While it is there no low-integrity program can open the folder.
    if (@(Get-NexusOwnEntries $folder $containerSid | Where-Object { $null -ne $_ }).Count -gt 0) {
      Invoke-NexusIcacls @($folder, '/remove', "*$containerSid", '/Q')
      Step "appcontainer-entry-removed:$folder"
    }
    if (@(Test-NexusAncestorEntry (Get-NexusOwnEntries $folder $capabilitySid)).Count -gt 0) {
      Invoke-NexusIcacls @($folder, '/remove', "*$capabilitySid", '/Q')
      Invoke-NexusIcacls @($folder, '/grant', "*$($capabilitySid):(RX)", '/Q')
    }
    $wrong = @(Test-NexusAncestorEntry (Get-NexusOwnEntries $folder $capabilitySid))
    if ($wrong.Count -gt 0) { throw "The folder $folder could not be opened to the sandbox's capability as intended: $($wrong -join '; ')." }
    if (@(Get-NexusOwnEntries $folder $containerSid | Where-Object { $null -ne $_ }).Count -gt 0) { throw "The entry for the AppContainer on $folder could not be removed." }
    Step "capability-entry:$folder"
  }
  # The loopback: NEXUS's proxy listens there, and it is the AppContainer's only way to the network. Windows
  # keeps AppContainers from the loopback on some machines; this is the exemption Windows has for it. Whether
  # the proxy is reached is established by use, at every start of NEXUS, not by this call's answer.
  try {
    $exempt = (& (Join-Path $env:SystemRoot 'System32\CheckNetIsolation.exe') LoopbackExempt -a "-p=$containerSid" 2>&1 | Out-String)
    $result.loopbackExempt = ($LASTEXITCODE -eq 0)
    Step $(if ($LASTEXITCODE -eq 0) { 'loopback-exempt' } else { "loopback-exempt-failed: $($exempt.Trim())" })
  } catch { $result.loopbackExempt = $false; Step "loopback-exempt-failed: $($_.Exception.Message)" }

  # 5. The record, where only an administrator writes: NEXUS compares what it is told about the account with this.
  if (-not (Test-Path $script:NexusSandboxKey)) { New-Item -Path $script:NexusSandboxKey -Force | Out-Null }
  $users = @()
  if ($null -ne $record) { $users = @($record.Users | Where-Object { $_ }) }
  if ($users -notcontains $MainUserSid) { $users += $MainUserSid }
  New-ItemProperty -Path $script:NexusSandboxKey -Name 'Version' -PropertyType String -Value '3' -Force | Out-Null
  New-ItemProperty -Path $script:NexusSandboxKey -Name 'AppContainerName' -PropertyType String -Value $script:NexusAppContainerName -Force | Out-Null
  New-ItemProperty -Path $script:NexusSandboxKey -Name 'AppContainerSid' -PropertyType String -Value $containerSid -Force | Out-Null
  New-ItemProperty -Path $script:NexusSandboxKey -Name 'CapabilitySid' -PropertyType String -Value $capabilitySid -Force | Out-Null
  # A value a pre-release build wrote for a filter that is not made any more.
  Remove-ItemProperty -Path $script:NexusSandboxKey -Name 'DnsFilter' -ErrorAction SilentlyContinue
  New-ItemProperty -Path $script:NexusSandboxKey -Name 'AccountName' -PropertyType String -Value $AccountName -Force | Out-Null
  New-ItemProperty -Path $script:NexusSandboxKey -Name 'AccountSid' -PropertyType String -Value $sid -Force | Out-Null
  New-ItemProperty -Path $script:NexusSandboxKey -Name 'Root' -PropertyType String -Value $full -Force | Out-Null
  New-ItemProperty -Path $script:NexusSandboxKey -Name 'Users' -PropertyType MultiString -Value ([string[]]$users) -Force | Out-Null
  Step 'record'

  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
} finally {
  $secure = $null
  try { ($result | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $ResultFile -Encoding UTF8 } catch { }
}
if ($result.ok) { exit 0 } else { exit 1 }
