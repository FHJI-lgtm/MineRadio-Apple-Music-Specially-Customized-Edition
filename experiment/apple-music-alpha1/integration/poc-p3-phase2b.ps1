# Explicit next-track check: if #4 is playing, one controlled NEXT must land on the playlist's #5.
param([string]$IdentityFile, [string]$OutFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
if (-not ('AmPocNext2' -as [type])) { Add-Type -Namespace Poc -Name AmPocNext2 -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);' -ErrorAction SilentlyContinue }
$id = Get-Content $IdentityFile -Raw -Encoding UTF8 | ConvertFrom-Json
$tracks = @($id.tracks)
$o = [ordered]@{ expectCurrent = [string]$tracks[3].name; expectAfterNext = [string]$tracks[4].name; steps = [ordered]@{}; verdict = '' }
$s0 = Get-AmSmtcState
$o.steps.before = @{ status = [string]$s0.status; title = [string]$s0.title; artist = [string]$s0.artist; matchesApiTrack4 = ((Normalize-AmText ([string]$s0.title)) -eq (Normalize-AmText ([string]$tracks[3].name))) }
[Poc.AmPocNext2]::keybd_event(0xB0, 0, 0, [System.UIntPtr]::Zero); [Poc.AmPocNext2]::keybd_event(0xB0, 0, 2, [System.UIntPtr]::Zero)
Start-Sleep -Seconds 7
$s1 = Get-AmSmtcState
$o.steps.afterNext = @{ status = [string]$s1.status; title = [string]$s1.title; artist = [string]$s1.artist; ts = (Get-Date).ToString('s') }
$o.steps.match = @{ equalsApiTrack5 = ((Normalize-AmText ([string]$s1.title)) -eq (Normalize-AmText ([string]$tracks[4].name))) }
if ($o.steps.before.matchesApiTrack4 -and $o.steps.match.equalsApiTrack5) { $o.verdict = 'PASS_CONTEXT' } elseif ($o.steps.match.equalsApiTrack5) { $o.verdict = 'PASS_CONTEXT_FROM_UNVERIFIED_START' } else { $o.verdict = 'FAIL_CONTEXT_MISMATCH' }
$json = ($o | ConvertTo-Json -Compress -Depth 6)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json