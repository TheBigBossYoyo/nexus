# 0.9: the state of the machine's sandbox setup, as an ordinary user sees it. Not elevated, changes nothing.
# One JSON object on standard output. Used by the reboot observations (scripts/v09-reboot-observation.mjs).
$ErrorActionPreference = 'Continue'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$out = [ordered]@{}
$os = Get-CimInstance Win32_OperatingSystem
$out.observedAt = (Get-Date).ToUniversalTime().ToString('o')
$out.lastBoot = $os.LastBootUpTime.ToUniversalTime().ToString('o')
$out.uptimeSeconds = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
$out.windows = "$($os.Caption) $($os.Version)"
$out.session = (Get-Process -Id $PID).SessionId
# Kernel-Boot 27: 0x0 a full start, 0x1 a fast startup (hybrid), 0x2 a resume from hibernation.
$boot = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Boot'; Id = 27 } -MaxEvents 1 -ErrorAction SilentlyContinue
$out.bootType = if ($boot) { '0x{0:x}' -f [int]$boot.Properties[0].Value } else { $null }
$out.bootTypeAt = if ($boot) { $boot.TimeCreated.ToUniversalTime().ToString('o') } else { $null }

$user = Get-LocalUser -Name 'NexusSandbox' -ErrorAction SilentlyContinue
$out.account = if ($user) { [ordered]@{ present = $true; enabled = [bool]$user.Enabled; sid = $user.SID.Value; description = [string]$user.Description; passwordLastSet = if ($user.PasswordLastSet) { $user.PasswordLastSet.ToUniversalTime().ToString('o') } else { $null } } } else { [ordered]@{ present = $false } }

$key = 'HKLM:\SOFTWARE\NexusSandbox'
$out.record = if (Test-Path $key) { $v = Get-ItemProperty $key; [ordered]@{ version = [string]$v.Version; accountSid = [string]$v.AccountSid; root = [string]$v.Root; appContainerName = [string]$v.AppContainerName; appContainerSid = [string]$v.AppContainerSid; capabilitySid = [string]$v.CapabilitySid; users = @($v.Users).Count } } else { $null }

$out.firewall = @(Get-NetFirewallRule -Name 'NexusSandbox-Block-*' -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ name = $_.Name; enabled = [string]$_.Enabled; direction = [string]$_.Direction; action = [string]$_.Action } })

# The startup task. An ordinary user is refused its definition ("access denied"), which still tells it from a
# task that is not there ("not found").
$taskName = 'NexusSandbox-RestoreCanonicalization'
$text = (& (Join-Path $env:SystemRoot 'System32\schtasks.exe') /query /tn $taskName /fo LIST /v 2>&1 | Out-String).Trim()
$code = $LASTEXITCODE
$visible = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).Count -gt 0
$out.startupTask = [ordered]@{ name = $taskName; queryExitCode = $code; readableUnelevated = ($code -eq 0); listedUnelevated = $visible; answer = if ($code -eq 0) { 'readable' } else { $text.Substring(0, [Math]::Min(200, $text.Length)) } }
$old = (& (Join-Path $env:SystemRoot 'System32\schtasks.exe') /query /tn 'NexusSetupElevated' 2>&1 | Out-String)
$out.obsoleteElevatedTask = [ordered]@{ name = 'NexusSetupElevated'; queryExitCode = $LASTEXITCODE }

# The privileged script and who may write it.
$dir = Join-Path $env:ProgramFiles 'NexusSandbox'
$script = Join-Path $dir 'restore-canonicalization.ps1'
if (Test-Path -LiteralPath $script) {
  $writers = @()
  foreach ($path in @($dir, $script)) {
    $acl = Get-Acl -LiteralPath $path
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      $write = [Security.AccessControl.FileSystemRights]'Write, Delete, ChangePermissions, TakeOwnership, DeleteSubdirectoriesAndFiles'
      if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') -notcontains $rule.IdentityReference.Value) { $writers += "$path : $($rule.IdentityReference.Value) $($rule.FileSystemRights)" }
    }
  }
  $out.bootstrapScript = [ordered]@{ path = $script; sha256 = (Get-FileHash -LiteralPath $script -Algorithm SHA256).Hash; owner = (Get-Acl -LiteralPath $script).GetOwner([Security.Principal.SecurityIdentifier]).Value; writableByOthersThanSystemAdminsTrustedInstaller = $writers }
  # The entry on the Mount Manager device, read with READ_CONTROL only (-Check changes nothing).
  $check = (& (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Check 2>&1 | Out-String).Trim()
  try { $out.mountManager = $check | ConvertFrom-Json } catch { $out.mountManager = [ordered]@{ ok = $false; error = $check.Substring(0, [Math]::Min(300, $check.Length)) } }
} else {
  $out.bootstrapScript = $null
  $out.mountManager = $null
}
$out.elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$out | ConvertTo-Json -Depth 6 -Compress
