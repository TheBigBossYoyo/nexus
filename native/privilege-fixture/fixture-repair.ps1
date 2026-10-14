# NEXUS privilege acceptance fixture: create Program Files\NexusPrivilegeFixture\bin (it inherits Program Files'
# own permissions: only administrators write there). Nothing else. Run only through the NEXUS broker, elevated.
param(
  [string]$ResultFile = ''
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramFiles 'NexusPrivilegeFixture'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'bin') | Out-Null
Set-Content -LiteralPath (Join-Path $root 'README.txt') -Value 'Made by the NEXUS privilege acceptance fixture. Removed by fixture-remove.ps1.' -Encoding ASCII
Write-Output "created $root\bin"
exit 0
