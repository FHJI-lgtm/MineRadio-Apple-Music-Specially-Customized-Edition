# ============================================================
# poc/play-playlist.ps1   (B-i CLI wrapper for the playlist engine)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File poc\play-playlist.ps1 -Name "My Playlist" -Human
#   powershell -ExecutionPolicy Bypass -File poc\play-playlist.ps1 -Name "My Playlist" -ScopeLabel "<library scope label>" -Commit
#
# Default is PROBE (nothing is clicked). -Commit clicks the matched playlist card.
# Output: one JSON line on stdout (plus human-readable lines with -Human).
# ASCII-only on purpose; the localized scope label is passed in by the caller.
# ============================================================
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$ScopeLabel = '',
  [int]$SearchWaitMs = 6000,
  [switch]$Commit,
  [switch]$HoverProbe,   [string]$PlayLabel = '',
  [int]$CardIndex = 0,
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
. (Join-Path $PSScriptRoot 'lib\am-play-playlist.ps1')

$r = Invoke-AmPlayPlaylist -Name $Name -ScopeLabel $ScopeLabel -SearchWaitMs $SearchWaitMs `
  -Commit:$Commit -NoLaunch:$NoLaunch -ShotPath $ShotPath -DumpItems:$DumpItems -CardIndex $CardIndex -HoverProbe:$HoverProbe -PlayLabel $PlayLabel

if ($Human) {
  Write-Host ('ok=' + $r.ok + '  stage=' + $r.stage + '  mode=' + $r.mode)
  Write-Host ('  detail="' + $r.stageDetail + '"')
  Write-Host ('  candidates=' + $r.candidateCount + ' ambiguous=' + $r.ambiguous + ' clicked=' + $r.clicked)
  foreach ($c in @($r.cards)) { Write-Host ('  card: ' + $c.name) }
}

Write-Output (ConvertTo-AmJsonCompact $r)
