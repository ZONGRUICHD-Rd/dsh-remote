<#
  DSH Remote bridge installer for DSH Desktop on Windows.

  1. Finds DSH Desktop's bundled `dsh` command.
  2. Installs the bridge plugin into the Desktop profile (`dsh plugin --profile desktop add`).
  3. Opens the Windows Firewall for the bridge port (private/domain networks).

  Usage:  install.cmd                     (double-click)
          install.ps1 [-DshProfile desktop|web] [-Port 39090] [-DshPath C:\...\dsh.cmd] [-AllNetworks] [-NoFirewall]
#>
param(
  [string]$DshProfile = 'desktop',
  [int]$Port = 39090,
  [string]$DshPath = '',
  [switch]$AllNetworks,
  [switch]$NoFirewall,
  [switch]$FirewallOnly
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$zh = (Get-Culture).Name -like 'zh*'
function Say([string]$cn, [string]$en) { if ($zh) { Write-Host $cn } else { Write-Host $en } }

function Add-FirewallRules {
  $profiles = if ($AllNetworks) { 'Any' } else { 'Private,Domain' }
  $script = @"
Remove-NetFirewallRule -DisplayName 'DSH Remote (TCP $Port)' -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName 'DSH Remote mDNS (UDP 5353)' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'DSH Remote (TCP $Port)' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile $profiles | Out-Null
New-NetFirewallRule -DisplayName 'DSH Remote mDNS (UDP 5353)' -Direction Inbound -Protocol UDP -LocalPort 5353 -Action Allow -Profile $profiles | Out-Null
"@
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdmin) {
    Invoke-Expression $script
  } else {
    Say '正在请求管理员权限以添加防火墙规则…' 'Requesting administrator rights to add firewall rules…'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    if ($p.ExitCode -ne 0) { throw "firewall rule creation failed ($($p.ExitCode))" }
  }
  Say "已放行入站 TCP $Port 与 UDP 5353（$profiles 网络）。" "Inbound TCP $Port and UDP 5353 allowed ($profiles networks)."
}

function Find-Dsh {
  if ($DshPath) { return $DshPath }
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')) {
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $entry = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($entry.DisplayName -like 'DeepSeek Harness*' -and $entry.InstallLocation) {
        $candidates.Add((Join-Path $entry.InstallLocation 'resources\runtime\cli\bin\dsh.cmd'))
      }
    }
  }
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'))
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command dsh.cmd, dsh -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}

if ($FirewallOnly) { Add-FirewallRules; exit 0 }

$package = Get-ChildItem $here -Filter 'dsh-remote-bridge-*.tgz' | Sort-Object Name | Select-Object -Last 1
if (-not $package) { throw 'dsh-remote-bridge-*.tgz not found next to install.ps1' }

$dsh = Find-Dsh
if (-not $dsh) {
  Say '未找到 DSH Desktop 的 dsh 命令。请先安装并启动一次 DSH Desktop，或用 -DshPath 指定 dsh.cmd 路径。' 'Could not find the dsh command of DSH Desktop. Install and launch DSH Desktop once, or pass -DshPath.'
  exit 1
}
Say "使用 dsh: $dsh" "Using dsh: $dsh"

if ($DshProfile -eq 'desktop') {
  $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($running) {
    Say 'DSH Desktop 正在运行。安装插件前需要完全退出（托盘图标 → 退出）。' 'DSH Desktop is running. It must be fully quit before installing plugins (tray icon → Quit).'
    $answer = Read-Host ($(if ($zh) { '现在自动关闭 DSH Desktop？[y/N]' } else { 'Close DSH Desktop now? [y/N]' }))
    if ($answer -match '^[yY]') {
      $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
      Start-Sleep -Seconds 3
      Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
      Start-Sleep -Seconds 1
    } else {
      exit 1
    }
  }
}

$spec = 'file:' + ($package.FullName -replace '\\', '/')
Say "正在安装 $($package.Name) 到 profile '$DshProfile' …" "Installing $($package.Name) into profile '$DshProfile' …"
& $dsh plugin --profile $DshProfile add $spec
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

if (-not $NoFirewall) {
  try { Add-FirewallRules } catch { Say "防火墙规则添加失败：$_ （可稍后以管理员运行 install.ps1 -FirewallOnly）" "Firewall rules failed: $_ (run install.ps1 -FirewallOnly as admin later)" }
}

Write-Host ''
Say '✅ 安装完成。重新打开 DSH Desktop，在任意对话中输入 /remote 查看配对码与管理页（二维码）。' '✅ Done. Reopen DSH Desktop and type /remote in any chat to see the pairing code and the admin page (QR code).'
Say "   管理页地址：http://127.0.0.1:39091/ （需通过 /remote 给出的带令牌链接首次打开）" "   Admin page: http://127.0.0.1:39091/ (open the tokenized link from /remote the first time)"
