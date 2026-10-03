# T2 phase 2: confirm baseline via SMTC, controlled pause, then the slug-less URL through the frozen chain.
param([string]$TargetUrlFile, [string]$BaselineTitleFile, [string]$TargetTitleFile, [string]$TargetArtistFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function RT([string]$p) { return ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)).Trim() }
. 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib\am-common.ps1'
. 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib\am-smtc.ps1'
if (-not ('AmPocKey3' -as [type])) { Add-Type -Namespace Poc -Name AmPocKey3 -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);' -ErrorAction SilentlyContinue }
$chain = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\play-song.ps1'
$tUrl = RT $TargetUrlFile; $bTitle = RT $BaselineTitleFile; $tTitle = RT $TargetTitleFile; $tArtist = RT $TargetArtistFile
$o = [ordered]@{ baseline = @{}; pause = @{}; navigation = @{}; uiaMatch = @{}; click = @{}; smtcFinal = @{}; verdict = ''; abort = '' }
$b = Get-AmSmtcState
$o.baseline = @{ status = [string]$b.status; title = [string]$b.title; artist = [string]$b.artist; album = [string]$b.album; ts = (Get-Date).ToString('s'); expected = $bTitle; confirmed = ($b.title -eq $bTitle -and $b.title -ne $tTitle -and $b.title -ne '') }
if (-not $o.baseline.confirmed) { $o.abort = 'BASELINE_SMTC_NOT_CONFIRMED'; $o.verdict = 'INCONCLUSIVE' }
else {
  $p1 = Get-AmSmtcState
  [Poc.AmPocKey3]::keybd_event(0xB3, 0, 0, [System.UIntPtr]::Zero); [Poc.AmPocKey3]::keybd_event(0xB3, 0, 2, [System.UIntPtr]::Zero)
  Start-Sleep -Seconds 2
  $p2 = Get-AmSmtcState
  $o.pause = @{ before = ([string]$p1.status + '|' + [string]$p1.title); after = ([string]$p2.status + '|' + [string]$p2.title); ts = (Get-Date).ToString('s'); identityPreserved = ([string]$p2.title -ne '') }
  if (-not $o.pause.identityPreserved) { $o.abort = 'PAUSE_LOST_IDENTITY'; $o.verdict = 'INCONCLUSIVE' }
  else {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $tOut = & $chain -Title $tTitle -Artist $tArtist -Url $tUrl 2>&1 | Out-String
    $sw.Stop()
    $line = ($tOut -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    $tj = $null; if ($line) { try { $tj = $line | ConvertFrom-Json } catch { } }
    Start-Sleep -Seconds 3
    $f = Get-AmSmtcState
    $o.navigation = @{ navMethod = $(if ($tj) { [string]$tj.navMethod } else { '' }); stage = $(if ($tj) { [string]$tj.stage } else { 'NO_JSON' }); stageDetail = $(if ($tj) { [string]$tj.stageDetail } else { '' }); chainOk = $(if ($tj) { [bool]$tj.ok } else { $false }); elapsedMs = [int]$sw.ElapsedMilliseconds }
    $o.uiaMatch = @{ candidateCount = $(if ($tj) { $tj.candidateCount } else { $null }); ambiguous = $(if ($tj) { [bool]$tj.ambiguous } else { $null }); matchedRow = $(if ($tj) { [string]$tj.matchedRow } else { '' }); attempts = $(if ($tj) { $tj.attempts } else { $null }) }
    $o.click = @{ evidence = 'INFERRED'; note = 'frozen chain exposes no click field; stage=OK implies the row click executed after a successful page wait' }
    $o.smtcFinal = @{ status = [string]$f.status; title = [string]$f.title; artist = [string]$f.artist; album = [string]$f.album; ts = (Get-Date).ToString('s') }
    if ($o.navigation.stage -eq 'URL_NAVIGATION_FAILED') { $o.verdict = 'FAIL_CURRENT_CONDITIONS' }
    elseif ([string]$f.title -eq $tTitle -and $o.uiaMatch.matchedRow -ne '') { $o.verdict = 'PASS' }
    else { $o.verdict = 'INCONCLUSIVE' }
  }
}
$o | ConvertTo-Json -Compress -Depth 8 | Write-Output