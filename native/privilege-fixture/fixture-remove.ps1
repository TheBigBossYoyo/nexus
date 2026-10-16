# NEXUS privilege acceptance fixture: remove what the fixture made (the Program Files folder and the registry key).
param(
  [string]$ResultFile = ''
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramFiles 'NexusAcceptanceFixture'
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
if (Test-Path -LiteralPath 'HKLM:\SOFTWARE\NexusAcceptanceFixture') { Remove-Item -LiteralPath 'HKLM:\SOFTWARE\NexusAcceptanceFixture' -Recurse -Force }
Write-Output 'removed'
exit 0
