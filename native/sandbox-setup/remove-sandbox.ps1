# NEXUS sandbox account: removal. Runs elevated. Undoes setup-sandbox.ps1: the firewall rules, the sign-in
# screen entry, the account, and (with -RemoveRoot) the sandbox root with everything in it.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [string]$AccountName = 'NexusSandbox',
  [string]$SandboxRoot = 'C:\ProgramData\NexusSandbox',
  [switch]$RemoveRoot
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{ ok = $false; steps = @(); error = $null }
try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'This removal must run elevated.' }
  if ($AccountName -notmatch '^[A-Za-z][A-Za-z0-9]{2,19}$') { throw 'AccountName must be 3 to 20 letters and digits.' }
  foreach ($direction in @('Outbound', 'Inbound')) {
    Get-NetFirewallRule -Name "NexusSandbox-Block-$direction" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    $result.steps += "firewall-$($direction.ToLower())-removed"
  }
  $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
  if (Test-Path $key) { Remove-ItemProperty -Path $key -Name $AccountName -ErrorAction SilentlyContinue; $result.steps += 'sign-in-entry-removed' }
  if (Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $AccountName; $result.steps += 'account-removed' }
  if ($RemoveRoot) {
    $full = [IO.Path]::GetFullPath($SandboxRoot)
    if ($full -notmatch '^[A-Za-z]:\\ProgramData\\[A-Za-z0-9_-]+$') { throw 'SandboxRoot must be a folder directly under ProgramData.' }
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force; $result.steps += 'root-removed' }
  }
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
} finally {
  try { ($result | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $ResultFile -Encoding UTF8 } catch { }
}
if ($result.ok) { exit 0 } else { exit 1 }
