# ============================================================
# poc/play-playlist.ps1   (B-i CLI wrapper for the playlist engine)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File poc\play-playlist.ps1 -Name "My Playlist" -Human
#   powershell -ExecutionPolicy Bypass -File poc\play-playlist.ps1 -Name "My Playlist" -ScopeLabel "<library scope label>" -Commit
#   The library scope label is localized and must be measured, not guessed: in the zh-CN app the
#   SearchLibrary chip is "你的资料库" (see REPORT-B-I-PLAYLIST-CARD.md 4.1). This file stays ASCII-only,
#   so pass a CJK label through a file: -ScopeLabel ([IO.File]::ReadAllText($p,[Text.Encoding]::UTF8))
#
# Default is PROBE (nothing is clicked). -Commit clicks the matched playlist card.
# Output: one JSON line on stdout (plus human-readable lines with -Human).
# ASCII-only on purpose; the localized scope label is passed in by the caller.
# ============================================================
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$ScopeLabel = '',
  [string]$Url = '',
  [int]$SearchWaitMs = 6000,
  [switch]$Commit,
  [switch]$HoverProbe,   [string]$PlayLabel = '',
  [int]$CardIndex = 0,
  [int]$SmtcTimeoutMs = 8000,
  [switch]$TryHoverPlay,
  [switch]$NoMinimize,
  [switch]$DumpItems,
  [switch]$NoLaunch,
  [switch]$Human,
  [string]$ShotPath = ''
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot 'lib\am-uia.ps1')
# reused read-only for Minimize-AmWindow (the same helper the verified song chain uses after its click)
. (Join-Path $PSScriptRoot 'lib\am-play.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play-playlist.ps1')

$r = Invoke-AmPlayPlaylist -Name $Name -ScopeLabel $ScopeLabel -Url $Url -SearchWaitMs $SearchWaitMs `
  -Commit:$Commit -NoLaunch:$NoLaunch -ShotPath $ShotPath -DumpItems:$DumpItems -CardIndex $CardIndex -HoverProbe:$HoverProbe -PlayLabel $PlayLabel -SmtcTimeoutMs $SmtcTimeoutMs -TryHoverPlay:$TryHoverPlay -NoMinimize:$NoMinimize

if ($Human) {
  Write-Host ('ok=' + $r.ok + '  stage=' + $r.stage + '  mode=' + $r.mode)
  Write-Host ('  detail="' + $r.stageDetail + '"')
  Write-Host ('  candidates=' + $r.candidateCount + ' ambiguous=' + $r.ambiguous + ' clicked=' + $r.clicked)
  foreach ($c in @($r.cards)) { Write-Host ('  card: ' + $c.name + '  rect=' + $c.rect) }
  Write-Host ('  smtc: before=' + $r.smtc.beforeStatus + ' after=' + $r.smtc.status + ' transitionMs=' + $r.smtc.transitionMs)
  Write-Host ('        beforeTitle="' + $r.smtc.beforeTitle + '" afterTitle="' + $r.smtc.title + '"')
}

Write-Output (ConvertTo-AmJsonCompact $r)
