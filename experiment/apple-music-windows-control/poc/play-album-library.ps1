# ============================================================
# poc/play-album-library.ps1   (NEW, non-frozen wrapper)
#
# Library album playback with SECTION-AWARE disambiguation.
# The frozen playlist engine already searches, force-selects the library scope chip and verifies it,
# but it refuses to guess when the name matches more than one card - and an album search is always
# ambiguous on Apple Music (album card 'Starboy' + song row 'Starboy (feat. Daft Punk)').
# So: probe first (nothing clicked), keep the candidate that sits in the album section (localized
# label passed in by the caller - this file stays ASCII-only), then commit THAT CardIndex.
# If no candidate sits in the section, the probe's AMBIGUOUS verdict is returned unchanged: no guessing.
#
# Usage: powershell -File poc\play-album-library.ps1 -Name "Starboy" -ScopeLabel <lib label> -SectionLabel <album label> -Commit
# ============================================================
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$ScopeLabel = '',
  [string]$SectionLabel = '',
  [string]$Url = '',
  [int]$SearchWaitMs = 6000,
  [int]$SmtcTimeoutMs = 8000,
  [switch]$Commit,
  [switch]$DumpItems
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot 'lib\am-uia.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play-playlist.ps1')

$probeArgs = @{ Name = $Name; ScopeLabel = $ScopeLabel; SearchWaitMs = $SearchWaitMs }
if ($Url) { $probeArgs['Url'] = $Url }
if ($DumpItems) { $probeArgs['DumpItems'] = $true }
$probe = Invoke-AmPlayPlaylist @probeArgs
$cards = @($probe.cards)
$pick = 0; $pickedName = ''; $pickedSection = ''; $disambiguation = ''
if ($cards.Count -eq 0) { $disambiguation = 'no-candidate' }
elseif ($cards.Count -eq 1) { $pick = 1; $pickedName = [string]$cards[0].name; $disambiguation = 'single' }
else {
  if ($SectionLabel) {
    for ($i = 0; $i -lt $cards.Count; $i++) {
      $hit = $false
      foreach ($anc in @($cards[$i].ancestors)) {
        if ($anc -and ([string]$anc).IndexOf($SectionLabel) -ge 0) { $hit = $true; break }
      }
      if ($hit) { $pick = $i + 1; $pickedName = [string]$cards[$i].name; $pickedSection = $SectionLabel; $disambiguation = 'section-match'; break }
    }
  }
  if ($pick -eq 0) { $disambiguation = 'ambiguous-no-section-match' }
}
$final = $probe
if ($Commit -and $pick -ge 1) {
  $commitArgs = @{ Name = $Name; ScopeLabel = $ScopeLabel; SearchWaitMs = $SearchWaitMs; CardIndex = $pick; Commit = $true; SmtcTimeoutMs = $SmtcTimeoutMs }
  if ($Url) { $commitArgs['Url'] = $Url }
  $final = Invoke-AmPlayPlaylist @commitArgs
}
$o = [ordered]@{}
foreach ($k in $final.Keys) { $o[$k] = $final[$k] }
$o['candidateCount'] = $cards.Count
$o['pickedIndex'] = $pick
$o['pickedName'] = $pickedName
$o['pickedSection'] = $pickedSection
$o['disambiguation'] = $disambiguation
$o['probeStage'] = [string]$probe.stage
$o | ConvertTo-Json -Compress -Depth 6 | Write-Output