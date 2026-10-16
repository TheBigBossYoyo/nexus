# NEXUS privilege acceptance fixture: "install" a tool into Program Files\NexusAcceptanceFixture\bin.
#
# It writes one text file and nothing else. When the bin folder is missing it fails on purpose (exit 3), so that the
# acceptance can show a failed privileged operation followed by a reviewed repair (fixture-repair.ps1) and a retry,
# all under one privilege session. Run only through the NEXUS broker, elevated.
param(
  [string]$Version = '1.0.0',
  [string]$ResultFile = ''
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[0-9]{1,3}(\.[0-9]{1,3}){0,3}$') { Write-Error 'the version is not valid'; exit 2 }
$root = Join-Path $env:ProgramFiles 'NexusAcceptanceFixture'
$bin = Join-Path $root 'bin'
if (-not (Test-Path -LiteralPath $bin -PathType Container)) {
  [Console]::Error.WriteLine("the folder $bin is missing: run fixture-repair.ps1 first")
  exit 3
}
Set-Content -LiteralPath (Join-Path $bin 'version.txt') -Value $Version -Encoding ASCII
Write-Output "installed version $Version in $bin"
exit 0
