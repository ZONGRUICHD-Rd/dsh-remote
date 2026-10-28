param([string]$DshProfile = 'desktop', [string]$DshPath = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. {
  # Reuse the locator from install.ps1 without running it.
  $src = Get-Content (Join-Path $here 'install.ps1') -Raw
  $start = $src.IndexOf('function Find-Dsh')
  $end = $src.IndexOf('if ($FirewallOnly)')
  Invoke-Expression $src.Substring($start, $end - $start)
}
$dsh = Find-Dsh
if (-not $dsh) { Write-Host 'dsh command not found'; exit 1 }
& $dsh plugin --profile $DshProfile remove dsh-remote-bridge
$script = "Remove-NetFirewallRule -DisplayName 'DSH Remote*' -ErrorAction SilentlyContinue"
Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile', '-Command', $script) -ErrorAction SilentlyContinue
Write-Host 'DSH Remote bridge removed. Paired devices and certificates stay in %USERPROFILE%\.dsh\dsh-remote (delete it to forget them).'
