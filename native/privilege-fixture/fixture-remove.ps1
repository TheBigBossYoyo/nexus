# NEXUS privilege acceptance fixture: remove what the fixture made (the Program Files folder and the registry key).
param(
  [string]$ResultFile = ''
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramFiles 'NexusPrivilegeFixture'
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
if (Test-Path -LiteralPath 'HKLM:\SOFTWARE\NexusPrivilegeFixture') { Remove-Item -LiteralPath 'HKLM:\SOFTWARE\NexusPrivilegeFixture' -Recurse -Force }
Write-Output 'removed'
exit 0
