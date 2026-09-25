# ============================================================
# poc/play-song.ps1
# CLI wrapper around the playSong engine (poc/lib/am-play.ps1).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File poc\play-song.ps1 -Title "Shape of You" -Artist "Ed Sheeran"
#   powershell -ExecutionPolicy Bypass -File poc\play-song.ps1 -Title "..." -Human
#   powershell -ExecutionPolicy Bypass -File poc\play-song.ps1 -Title "..." -PauseFirst   (pause+settle before timing)
#
# Output: one JSON line on stdout (plus human-readable lines with -Human).
# ASCII-only on purpose; non-ASCII titles are passed as arguments or read from songs.json.
# ============================================================
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Artist = '',
  [string]$SongId = '',
  [string]$Url = '',
  [int]$TimeoutMs = 6000,
  [int]$Retries = 2,
  [int]$SearchWaitMs = 6000,
  [switch]$PauseFirst,
  [switch]$NoLaunch,
  [switch]$Human,
  [string]$ShotPath = ''
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot 'lib\am-uia.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play.ps1')

$r = Invoke-AmPlaySong -Title $Title -Artist $Artist -SongId $SongId -Url $Url -TimeoutMs $TimeoutMs `
  -Retries $Retries -SearchWaitMs $SearchWaitMs -PauseFirst:$PauseFirst -NoLaunch:$NoLaunch -ShotPath $ShotPath

if ($Human) {
  Write-Host ('ok=' + $r.ok + '  stage=' + $r.stage + '  attempts=' + $r.attempts + '  e2e=' + $r.t.e2eMs + 'ms  stages=' + ($r.stageHistory -join '>'))
  Write-Host ('  matchedRow="' + $r.matchedRow + '"')
  Write-Host ('  candidates=' + $r.candidateCount + ' ambiguous=' + $r.ambiguous + ' pickedByPosition=' + $r.pickedByPosition + ' artistFiltered=' + $r.artistFiltered)
  Write-Host ('  baseline: status=' + $r.baseline.status + ' title="' + $r.baseline.title + '"')
  Write-Host ('  smtc: title="' + $r.smtc.title + '" artist="' + $r.smtc.artist + '" status=' + $r.smtc.status + ' posMs=' + $r.smtc.posMs)
  Write-Host ('  t: ensure=' + $r.t.ensureAppMs + ' search=' + $r.t.searchMs + ' settle=' + $r.t.settleMs + ' list=' + $r.t.listMs + ' select=' + $r.t.selectMs + ' realize=' + $r.t.realizeMs + ' click=' + $r.t.clickMs + ' smtc=' + $r.t.smtcMs + ' e2e=' + $r.t.e2eMs)
  if ($r.stageDetail) { Write-Host ('  detail: ' + $r.stageDetail) }
}
Write-Output (ConvertTo-AmJsonCompact $r)
