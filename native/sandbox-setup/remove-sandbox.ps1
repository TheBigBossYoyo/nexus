# NEXUS sandbox account: removal. Runs elevated. Undoes setup-sandbox.ps1: the firewall rules, the sign-in
# screen entry, the account, the machine's record, and (with -RemoveRoot) the sandbox root with everything in it.
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
  if ($null -ne $account -and -not $ours) {
    $result.left += "the account $AccountName (it does not carry the mark of NEXUS's setup)"
  } else {
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
