# ============================================================
# poc/discover-songs.ps1
# Freeze / verify the test songs: for every entry in poc/songs.json this plays the
# song once through the engine and reports the exact SMTC result. It also shows
# how the song was located (mode, candidate count, ambiguity) so the frozen
# definitions can be trusted before the 60-run stability test.
#
# It needs no network when songs.json already carries a url; pass -Resolve to
# (re)resolve missing urls through the public iTunes Search API.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File poc\discover-songs.ps1
#   powershell -ExecutionPolicy Bypass -File poc\discover-songs.ps1 -Resolve
# ASCII-only on purpose (song titles come from songs.json as UTF-8).
# ============================================================
[CmdletBinding()]
param(
  [switch]$Resolve,
  [int]$Retries = 1
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot 'lib\am-uia.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play.ps1')
. (Join-Path $PSScriptRoot 'lib\am-resolve.ps1')

$findings = Get-AmFindingsDir
$stamp = Get-AmStamp
$jsonl = Join-Path $findings ('discover-' + $stamp + '.jsonl')
$txt = Join-Path $findings ('discover-' + $stamp + '.txt')
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $lines.Add($t); Write-Host $t }

$cfg = Read-AmSongs
$songs = @($cfg.songs | Where-Object { $_.title })
Say ('=== discover/verify ' + $songs.Count + ' songs   ' + (Get-AmIsoNow) + ' ===')

foreach ($s in $songs) {
  $url = '' + $s.url
  if ((-not $url) -and $Resolve) {
    $ra = '' + $s.resolveArtist
    if (-not $ra) { $ra = '' + $s.artist }
    $res = Resolve-AmSongUrl -Title ('' + $s.title) -Artist $ra
    if (-not $res.ok) { $res = Resolve-AmSongUrl -Title ('' + $s.title) -Artist '' -Storefront 'tw' }
    if ($res.ok) { $url = $res.url; Say ('  [' + $s.id + '] resolved url=' + $url) }
    else { Say ('  [' + $s.id + '] resolve failed: ' + $res.error) }
  }

  $r = Invoke-AmPlaySong -Title ('' + $s.title) -Artist ('' + $s.artist) -SongId ('' + $s.id) -Url $url `
    -Retries $Retries -PauseFirst -SearchWaitMs 6000 -PageWaitMs 12000

  $rec = @{
    kind = 'discover'; songId = $s.id; title = $s.title; artist = $s.artist; url = $url
    ok = $r.ok; stage = $r.stage; mode = $r.mode; attempts = $r.attempts
    e2eMs = $r.t.e2eMs; smtcMs = $r.t.smtcMs; realizeMs = $r.t.realizeMs; settleMs = $r.t.settleMs
    matchedRow = $r.matchedRow; candidateCount = $r.candidateCount; ambiguous = $r.ambiguous
    smtcTitle = $r.smtc.title; smtcArtist = $r.smtc.artist; smtcStatus = $r.smtc.status
    stageHistory = $r.stageHistory; stageDetail = $r.stageDetail
    ts = $r.ts; tsMs = $r.tsMs
  }
  Add-AmJsonLine $jsonl $rec

  Say ('  [' + $s.id + '] "' + $s.title + '" / ' + $s.artist)
  Say ('      ok=' + $r.ok + ' stage=' + $r.stage + ' mode=' + $r.mode + ' attempts=' + $r.attempts + ' e2e=' + $r.t.e2eMs + 'ms (smtc=' + $r.t.smtcMs + ')')
  Say ('      row="' + $r.matchedRow + '" candidates=' + $r.candidateCount + ' ambiguous=' + $r.ambiguous + ' pickedByPosition=' + $r.pickedByPosition)
  Say ('      smtc: title="' + $r.smtc.title + '" artist="' + $r.smtc.artist + '" status=' + $r.smtc.status)
  if ($r.stageDetail) { Say ('      detail: ' + $r.stageDetail) }
  if ($r.smtcTitle -eq '') { }
  # keep the measured SMTC strings in the report so songs.json can be frozen with them
  $s | Add-Member -NotePropertyName measuredSmtcTitle -NotePropertyValue $r.smtc.title -Force
  $s | Add-Member -NotePropertyName measuredSmtcArtist -NotePropertyValue $r.smtc.artist -Force
  Start-Sleep -Milliseconds 600
}

Say ''
Say '=== measured SMTC strings (copy into songs.json to freeze) ==='
foreach ($s in $songs) {
  Say ('  ' + $s.id + ': title="' + $s.measuredSmtcTitle + '" artist="' + $s.measuredSmtcArtist + '"')
}
Write-AmText $txt ($lines -join "`r`n")
Write-Host ''
Write-Host ('report: ' + $txt)
Write-Host ('jsonl : ' + $jsonl)
