# NEXUS sandbox account: removal. Runs elevated. Undoes setup-sandbox.ps1: the firewall rules, the sign-in
# screen entry, the AppContainer's entries on the two folders above the root and its loopback exemption, the
# account with the Windows profile it got when it first ran a command, the machine's record, and (with
# -RemoveRoot) the sandbox root with everything in it.
#
# It removes what the setup made and nothing else. An account of that name that does not carry the setup's
# mark is somebody else's and is left where it is; a folder that is a link, or that belongs to somebody else,
# is not followed and not deleted. Each thing left alone is named in the result.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [string]$AccountName = 'NexusSandbox',
  [string]$SandboxRoot = 'C:\ProgramData\NexusSandbox',
  [string]$MainUserSid = '',
  [switch]$RemoveRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'sandbox-checks.ps1')
$result = [ordered]@{ ok = $false; steps = @(); left = @(); error = $null }
try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'This removal must run elevated.' }
  if ($AccountName -notmatch '^[A-Za-z][A-Za-z0-9]{2,19}$') { throw 'AccountName must be 3 to 20 letters and digits.' }
  $account = Get-NexusAccountState $AccountName
  $ours = $false
  if ($null -ne $account) { $ours = (Test-NexusAccountState $account).Ours }

  foreach ($direction in @('Outbound', 'Inbound')) {
    $name = "NexusSandbox-Block-$direction"
    $state = Get-NexusFirewallRuleState $name
    if ($null -eq $state) { continue }
    # A rule of that name for another account, or of another kind, is not this setup's.
    if ($null -ne $account -and $state.LocalUser -eq "D:(A;;CC;;;$($account.Sid))" -and $state.Action -eq 'Block') {
      Get-NetFirewallRule -Name $name | Remove-NetFirewallRule
      $result.steps += "firewall-$($direction.ToLower())-removed"
    } else { $result.left += "the firewall rule $name (it is not the one the setup makes)" }
  }
  # The filter an earlier build made, if it is there. It carries NEXUS's own key: nobody else's is touched.
  try { Remove-NexusDnsFilter } catch { $result.left += "the RPC filter $($script:NexusDnsFilterKey) ($($_.Exception.Message))" }
  # The AppContainer's entries above the root and its loopback exemption. The identifier is the one Windows
  # derives from NEXUS's own name for it: an entry for it on these folders is nobody else's.
  try {
    $containerSid = Get-NexusAppContainerSid
    foreach ($folder in (Get-NexusAncestorFolders ([IO.Path]::GetFullPath($SandboxRoot)))) {
      if (-not (Test-Path -LiteralPath $folder) -or (Test-NexusReparsePoint $folder)) { continue }
      foreach ($entrySid in @((Get-NexusCapabilitySid), $containerSid)) {
        if (@(Get-NexusOwnEntries $folder $entrySid | Where-Object { $null -ne $_ }).Count -gt 0) {
          Invoke-NexusIcacls @($folder, '/remove', "*$entrySid", '/Q')
          $result.steps += "sandbox-entry-removed:$folder"
        }
      }
    }
    [void](& (Join-Path $env:SystemRoot 'System32\CheckNetIsolation.exe') LoopbackExempt -d "-p=$containerSid" 2>&1 | Out-String)
  } catch { $result.left += "the AppContainer's entries on the folders above the sandbox root ($($_.Exception.Message))" }
  # The startup bootstrap: its task, the entry it keeps on the Mount Manager device, and its script.
  try {
    $task = Get-ScheduledTask -TaskName $script:NexusBootstrapTask -ErrorAction SilentlyContinue
    if ($null -ne $task) { Unregister-ScheduledTask -TaskName $script:NexusBootstrapTask -Confirm:$false; $result.steps += 'startup-task-removed' }
    $restore = Join-Path $PSScriptRoot 'restore-canonicalization.ps1'
    if (Test-Path -LiteralPath $restore) {
      [void](& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $restore -Remove 2>&1 | Out-String)
      if ($LASTEXITCODE -eq 0) { $result.steps += 'canonicalization-entry-removed' } else { $result.left += 'the entry of the sandbox on the Mount Manager device (it is gone at the next start of Windows)' }
    }
    $bootstrapDir = Get-NexusBootstrapDir
    if ((Test-Path -LiteralPath $bootstrapDir) -and -not (Test-NexusReparsePoint $bootstrapDir)) {
      Remove-Item -LiteralPath (Join-Path $bootstrapDir 'restore-canonicalization.ps1') -Force -ErrorAction SilentlyContinue
      # Only if nothing else is in it: the folder is removed when it is empty, and left with what it holds otherwise.
      if (@(Get-ChildItem -LiteralPath $bootstrapDir -Force).Count -eq 0) { Remove-Item -LiteralPath $bootstrapDir -Force; $result.steps += 'bootstrap-folder-removed' } else { $result.left += "the folder $bootstrapDir (it holds something that is not NEXUS's)" }
    }
  } catch { $result.left += "the startup task of the sandbox ($($_.Exception.Message))" }
  if ($null -ne $account -and -not $ours) {
    $result.left += "the account $AccountName (it does not carry the mark of NEXUS's setup)"
  } else {
    # The account's Windows profile, made when it first ran a command in the AppContainer. It is found by the
    # account's identifier in Windows' own list of profiles, never by a folder's name, and removed by Windows
    # (folder and registry entry together). Left alone, and said so, when it is in use, is a link, or is not a
    # folder directly inside the machine's profiles folder.
    if ($null -ne $account) {
      try {
        $profile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$($account.Sid)'" -ErrorAction Stop
        if ($null -ne $profile) {
          $profiles = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList').ProfilesDirectory))
          $path = [IO.Path]::GetFullPath([string]$profile.LocalPath)
          if ($profile.Loaded) { $result.left += "the profile folder $path (it is in use)" }
          elseif ($profile.Special) { $result.left += "the profile folder $path (Windows marks it as a system profile)" }
          elseif ((Split-Path -Parent $path) -ne $profiles) { $result.left += "the profile folder $path (it is not directly inside $profiles)" }
          elseif ((Test-Path -LiteralPath $path) -and (Test-NexusReparsePoint $path)) { $result.left += "the profile folder $path (it is a link to another place)" }
          else { Remove-CimInstance -InputObject $profile -ErrorAction Stop; $result.steps += 'profile-removed' }
        }
      } catch { $result.left += "the account's profile ($($_.Exception.Message))" }
    }
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
    if (Test-Path $key) { Remove-ItemProperty -Path $key -Name $AccountName -ErrorAction SilentlyContinue; $result.steps += 'sign-in-entry-removed' }
    if ($null -ne $account) { Remove-LocalUser -SID $account.Sid; $result.steps += 'account-removed' }
    if (Test-Path $script:NexusSandboxKey) { Remove-Item -Path $script:NexusSandboxKey -Recurse -Force; $result.steps += 'record-removed' }
  }
  if ($RemoveRoot) {
    $full = [IO.Path]::GetFullPath($SandboxRoot)
    if ($full -notmatch '^[A-Za-z]:\\ProgramData\\[A-Za-z0-9_-]+$') { throw 'SandboxRoot must be a folder directly under ProgramData.' }
    $root = Get-NexusRootState $full
    if ($null -ne $root) {
      $owners = @($script:AdminsSid, $script:SystemSid)
      if ($MainUserSid -match '^S-1-5-21-[0-9-]+$') { $owners += $MainUserSid }
      if ($root.Reparse -or -not $root.IsDirectory) { $result.left += "the folder $full (it is a link or not a folder)" }
      elseif ($owners -notcontains $root.Owner) { $result.left += "the folder $full (it belongs to somebody else: $($root.Owner))" }
      else {
        # Links inside are removed as links: what they lead to is not touched.
        Get-ChildItem -LiteralPath $full -Force -Recurse -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object { $_.Delete() }
        Remove-Item -LiteralPath $full -Recurse -Force
        $result.steps += 'root-removed'
      }
    }
  }
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
} finally {
  try { ($result | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $ResultFile -Encoding UTF8 } catch { }
}
if ($result.ok) { exit 0 } else { exit 1 }
