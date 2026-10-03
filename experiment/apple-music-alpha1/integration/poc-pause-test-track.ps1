$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$lib='F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
if (-not ('AmPocKey' -as [type])) { Add-Type -Namespace Poc -Name AmPocKey -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);' -ErrorAction SilentlyContinue }
$s0 = Get-AmSmtcState
$o = [ordered]@{ before = ([string]$s0.status + '|' + [string]$s0.title); paused = $false; after = '' }
if ([string]$s0.title -eq 'Faith' -and [string]$s0.status -eq 'Playing') {
  [Poc.AmPocKey]::keybd_event(0xB3, 0, 0, [System.UIntPtr]::Zero); [Poc.AmPocKey]::keybd_event(0xB3, 0, 2, [System.UIntPtr]::Zero)
  Start-Sleep -Seconds 3
  $o.paused = $true
}
$s1 = Get-AmSmtcState
$o.after = ([string]$s1.status + '|' + [string]$s1.title)
$o | ConvertTo-Json -Compress -Depth 4
Get-Process | Where-Object { $_.ProcessName -match 'electron' } | Measure-Object | Select-Object -ExpandProperty Count
powershell -NoProfile -ExecutionPolicy Bypass -File 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration\probe-stealth.ps1'