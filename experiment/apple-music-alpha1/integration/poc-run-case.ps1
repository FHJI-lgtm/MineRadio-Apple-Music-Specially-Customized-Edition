# Fixed POC executor: a clean, DISTINCT baseline is mandatory before the target URL is touched.
param([string]$Id, [string]$TargetUrlFile, [string]$TargetTitleFile, [string]$TargetArtistFile, [string]$BaselineUrlFile, [string]$BaselineTitleFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function RT([string]$p) { return ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)).Trim() }
. 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib\am-common.ps1'
. 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib\am-smtc.ps1'
if (-not ('AmPocKey2' -as [type])) { Add-Type -Namespace Poc -Name AmPocKey2 -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);' -ErrorAction SilentlyContinue }
$chain = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\play-song.ps1'
$tUrl = RT $TargetUrlFile; $tTitle = RT $TargetTitleFile; $tArtist = RT $TargetArtistFile
$bUrl = RT $BaselineUrlFile; $bTitle = RT $BaselineTitleFile
$o = [ordered]@{ id = $Id; targetUrl = $tUrl; targetTitle = $tTitle; baseline = @{}; abort = ''; navigation = @{}; uiaMatch = @{}; click = @{}; smtcAfter = @{}; verdict = '' }
$pre = Get-AmSmtcState
$o.baseline.preState = ([string]$pre.status + '|' + [string]$pre.title)
$bOut = & $chain -Title $bTitle -Url $bUrl 2>&1 | Out-String
$bLine = ($bOut -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
$bj = $null; if ($bLine) { try { $bj = $bLine | ConvertFrom-Json } catch { } }
Start-Sleep -Seconds 3
$b1 = Get-AmSmtcState
$o.baseline.playedTitle = [string]$b1.title
$o.baseline.artist = [string]$b1.artist
$o.baseline.album = [string]$b1.album
$o.baseline.status = [string]$b1.status
$o.baseline.ts = (Get-Date).ToString('s')
$o.baseline.chainStage = $(if ($bj) { [string]$bj.stage } else { 'NO_JSON' })
$o.baseline.chainNavMethod = $(if ($bj) { [string]$bj.navMethod } else { '' })
$o.baseline.confirmedDistinct = ([string]$b1.title -eq $bTitle -and [string]$b1.title -ne $tTitle -and [string]$b1.title -ne '')
if (-not $o.baseline.confirmedDistinct) {
  $o.abort = 'BASELINE_NOT_CONFIRMED_OR_EQUALS_TARGET'
  $o.verdict = 'INCONCLUSIVE'
} else {
  [Poc.AmPocKey2]::keybd_event(0xB3, 0, 0, [System.UIntPtr]::Zero); [Poc.AmPocKey2]::keybd_event(0xB3, 0, 2, [System.UIntPtr]::Zero)
  Start-Sleep -Seconds 2
  $bp = Get-AmSmtcState
  $o.baseline.pauseResult = ([string]$bp.status + '|' + [string]$bp.title)
  $tOut = & $chain -Title $tTitle -Artist $tArtist -Url $tUrl 2>&1 | Out-String
  $tLine = ($tOut -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  $tj = $null; if ($tLine) { try { $tj = $tLine | ConvertFrom-Json } catch { } }
  Start-Sleep -Seconds 3
  $ta = Get-AmSmtcState
  $o.navigation = @{ navMethod = $(if ($tj) { [string]$tj.navMethod } else { '' }); stage = $(if ($tj) { [string]$tj.stage } else { 'NO_JSON' }); stageDetail = $(if ($tj) { [string]$tj.stageDetail } else { '' }); chainOk = $(if ($tj) { [bool]$tj.ok } else { $false }) }
  $o.uiaMatch = @{ candidateCount = $(if ($tj) { $tj.candidateCount } else { $null }); ambiguous = $(if ($tj) { [bool]$tj.ambiguous } else { $null }); matchedRow = $(if ($tj) { [string]$tj.matchedRow } else { '' }); attempts = $(if ($tj) { $tj.attempts } else { $null }) }
  $o.click = @{ chainStage = $(if ($tj) { [string]$tj.stage } else { '' }); note = 'frozen chain does not expose the click as its own field; OK implies the row click ran' }
  $o.smtcAfter = @{ status = [string]$ta.status; title = [string]$ta.title; artist = [string]$ta.artist }
  if ($o.navigation.stage -eq 'URL_NAVIGATION_FAILED') { $o.verdict = 'FAIL_CURRENT_CONDITIONS' }
  elseif ([string]$ta.title -eq $tTitle) { $o.verdict = 'PASS' }
  else { $o.verdict = 'INCONCLUSIVE' }
}
$o | ConvertTo-Json -Compress -Depth 8 | Write-Output