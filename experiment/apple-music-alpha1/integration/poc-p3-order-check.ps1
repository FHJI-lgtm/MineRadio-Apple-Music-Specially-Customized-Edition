# Order check: from the track at StartIndex, two controlled NEXTs must follow the playlist order.
param([string]$IdentityFile, [int]$StartIndex, [int]$Steps, [string]$OutFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
if (-not ('AmPocOrd' -as [type])) { Add-Type -Namespace Poc -Name AmPocOrd -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);' -ErrorAction SilentlyContinue }
$j = Get-Content $IdentityFile -Raw -Encoding UTF8 | ConvertFrom-Json
$tracks = @($j.tracks)
$o = [ordered]@{ playlist = [string]$j.playlist.name; startIndex = ($StartIndex + 1); steps = @(); verdict = '' }
$s0 = Get-AmSmtcState
$o.observedStart = @{ status = [string]$s0.status; title = [string]$s0.title; expected = [string]$tracks[$StartIndex].name; match = ((Normalize-AmText ([string]$s0.title)) -eq (Normalize-AmText ([string]$tracks[$StartIndex].name))) }
for ($i = 1; $i -le $Steps; $i++) {
  [Poc.AmPocOrd]::keybd_event(0xB0, 0, 0, [System.UIntPtr]::Zero); [Poc.AmPocOrd]::keybd_event(0xB0, 0, 2, [System.UIntPtr]::Zero)
  Start-Sleep -Seconds 7
  $s = Get-AmSmtcState
  $exp = [string]$tracks[$StartIndex + $i].name
  $o.steps += @{ step = $i; expectedIndex = ($StartIndex + $i + 1); expected = $exp; got = [string]$s.title; artist = [string]$s.artist; status = [string]$s.status; ts = (Get-Date).ToString('s'); match = ((Normalize-AmText ([string]$s.title)) -eq (Normalize-AmText $exp)) }
}
$allMatch = @($o.steps | Where-Object { -not $_.match }).Count -eq 0
if ($allMatch -and $o.observedStart.match) { $o.verdict = 'PASS_CONTEXT' } elseif ($allMatch) { $o.verdict = 'PASS_ORDER_START_UNVERIFIED' } else { $o.verdict = 'FAIL_CONTEXT_MISMATCH' }
$json = ($o | ConvertTo-Json -Compress -Depth 8)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json