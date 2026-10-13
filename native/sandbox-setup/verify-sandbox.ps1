# NEXUS sandbox account: verification. Not elevated, changes nothing, run by NEXUS at every start before the
# isolated profile is used, and by anyone who wants to know what state the machine is in.
#
# It answers one question: are the account, the folder and the record what NEXUS's setup makes them, for this
# user? The names alone prove nothing; see sandbox-checks.ps1. Whether the firewall really keeps the account
# off the network is established separately, by running a process as the account and trying (the launcher's
# own verification): a rule's shape is read here when Windows lets an ordinary user read it, and reported.
#
# Output: one JSON object on standard output. `ok` is true only when nothing is wrong.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AccountName,
  [Parameter(Mandatory = $true)][string]$AccountSid,
  [Parameter(Mandatory = $true)][string]$SandboxRoot,
  # The identifiers of the AppContainer the launcher will use and of the capability it holds (derived by the
  # launcher from the name). Checked against the machine's record, which the elevated setup derived itself.
  [string]$AppContainerSid = '',
  [string]$CapabilitySid = '',
  [string]$MainUserSid = ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'sandbox-checks.ps1')
$out = [ordered]@{ ok = $false; problems = @(); notes = @(); account = $null; root = $null; record = $null; firewall = @{} }
try {
  $problems = @()
  $account = Get-NexusAccountState $AccountName
  $out.account = $account
  if ($null -eq $account) { $problems += "there is no account named $AccountName" }
  else {
    if ($account.Sid -ne $AccountSid) { $problems += "the account named $AccountName is not the one NEXUS was told of (it is $($account.Sid), not $AccountSid)" }
    $check = Test-NexusAccountState $account
    $problems += $check.Problems
    # A mark of the earlier setup is the same account; what else could be repaired is, until it is, wrong.
    $problems += @($check.Repairable | Where-Object { $_ -ne 'carries the mark of an earlier setup' })
    if ($check.Repairable -contains 'carries the mark of an earlier setup') { $out.notes += 'the account carries the mark of an earlier setup; running the setup again brings it up to date' }
  }

  $full = [IO.Path]::GetFullPath($SandboxRoot)
  if ($full -notmatch '^[A-Za-z]:\\ProgramData\\[A-Za-z0-9_-]+$') { $problems += "the folder $full is not a folder directly under ProgramData" }
  $root = Get-NexusRootState $full
  $out.root = if ($null -ne $root) { [pscustomobject]@{ Path = $root.Path; Reparse = $root.Reparse; Owner = $root.Owner; Protected = $root.Protected; Rules = $root.Rules } } else { $null }
  if ($null -eq $root) { $problems += "the folder $full does not exist" }
  else {
    $check = Test-NexusRootState $root $MainUserSid $AccountSid -Strict -AppContainerSid $CapabilitySid
    foreach ($problem in $check.Problems) { $problems += "the folder $full`: $problem" }
  }

  $record = Get-NexusSandboxRecord
  $out.record = $record
  if ($null -eq $record) { $out.notes += 'the machine has no record of the setup (it was made by an earlier version); running the setup again writes it' }
  else {
    if ($record.AccountSid -ne $AccountSid) { $problems += "the machine's record names another account ($($record.AccountSid))" }
    if ([IO.Path]::GetFullPath($record.Root) -ne $full) { $problems += "the machine's record names another folder ($($record.Root))" }
    if ($AppContainerSid) {
      if (-not $record.AppContainerSid) { $problems += 'the setup on this machine was made before contained commands ran in an AppContainer; run the setup again' }
      elseif ($record.AppContainerSid -ne $AppContainerSid) { $problems += "the machine's record names another AppContainer ($($record.AppContainerSid))" }
      elseif ($record.CapabilitySid -ne $CapabilitySid) { $problems += 'the setup on this machine was made by a pre-release build; run the setup again' }
    }
    if ($record.Users -notcontains $MainUserSid) { $out.notes += 'the record does not list this user; running the setup again adds it' }
  }

  if ($AppContainerSid -and $null -ne $root) {
    if ($AppContainerSid -notmatch '^S-1-15-2-[0-9-]+$' -or $CapabilitySid -notmatch '^S-1-15-3-1024-[0-9-]+$') { $problems += 'the AppContainer or capability identifier is not one' }
    else {
      foreach ($folder in (Get-NexusAncestorFolders $full)) {
        try {
          $wrong = @(Test-NexusAncestorEntry (Get-NexusOwnEntries $folder $CapabilitySid))
          foreach ($problem in $wrong) { $problems += "the folder $folder`: $problem; run the setup again" }
          if (@(Get-NexusOwnEntries $folder $AppContainerSid | Where-Object { $null -ne $_ }).Count -gt 0) { $problems += "the folder $folder has an entry for the AppContainer itself, which keeps low-integrity programs out of it; run the setup again" }
        } catch { $problems += "the access list of $folder could not be read: $($_.Exception.Message)" }
      }
    }
  }

  foreach ($direction in @('Outbound', 'Inbound')) {
    try {
      $state = Get-NexusFirewallRuleState "NexusSandbox-Block-$direction"
      $wrong = @(Test-NexusFirewallRuleState $state $direction $AccountSid)
      $out.firewall[$direction] = if ($wrong.Count -eq 0) { 'as it should be' } else { $wrong -join '; ' }
      if ($wrong.Count -gt 0 -and $direction -eq 'Outbound') { $problems += "the outbound firewall rule: $($wrong -join '; ')" }
    } catch {
      $out.firewall[$direction] = "could not be read: $($_.Exception.Message)"
    }
  }

  $out.problems = @($problems)
  $out.ok = $problems.Count -eq 0
} catch {
  $out.problems = @("the verification itself failed: $($_.Exception.Message)")
}
$out | ConvertTo-Json -Depth 5 -Compress
if ($out.ok) { exit 0 } else { exit 1 }
