# ============================================================
# poc/stability-test.ps1
# Core-reliability run: every frozen song in poc/songs.json is played `Runs`
# times (interleaved A -> B -> C per round, so switching songs is exercised too).
#
# Before every attempt the session is paused and allowed to settle, so a previous
# attempt can never be mistaken for a fresh successful play. Success is decided
# ONLY by SMTC (Playing + title match, artist match when provided).
#
# Outputs (findings/poc/):
#   stability-<stamp>.jsonl  one JSON object per attempt (all raw fields)
#   stability-<stamp>.csv    flat table
#   stability-<stamp>.md     success rates, latency stats, failure-stage counts
#
# Usage: powershell -ExecutionPolicy Bypass -File poc\stability-test.ps1 [-Runs 20] [-Retries 1]
# ASCII-only on purpose (titles come from songs.json as UTF-8).
# ============================================================
[CmdletBinding()]
param(
  [int]$Runs = 20,
  [int]$Retries = 1
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot 'lib\am-uia.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play.ps1')

$findings = Get-AmFindingsDir
$stamp = Get-AmStamp
$jsonl = Join-Path $findings ('stability-' + $stamp + '.jsonl')
$csv = Join-Path $findings ('stability-' + $stamp + '.csv')
$md = Join-Path $findings ('stability-' + $stamp + '.md')

$songs = @(Get-AmFrozenSongs)
if ($songs.Count -eq 0) { Write-Host 'no frozen songs in songs.json'; exit 1 }
$shots = Join-Path $findings 'shots'
if (-not (Test-Path $shots)) { New-Item -ItemType Directory -Force -Path $shots | Out-Null }

Write-Host ('=== stability test: ' + $songs.Count + ' songs x ' + $Runs + ' runs = ' + ($songs.Count * $Runs) + ' attempts   (retries=' + $Retries + ') ===')
Write-Host 'Do not move the mouse or keyboard while this runs.'
foreach ($s in $songs) { Write-Host ('  song ' + $s.id + ': "' + $s.title + '" / ' + $s.artist + '  url=' + $(if ($s.url) { 'yes' } else { '(none: search path)' })) }
Write-Host ''

$records = New-Object System.Collections.Generic.List[object]
$n = 0
$total = $songs.Count * $Runs
for ($round = 1; $round -le $Runs; $round++) {
  foreach ($s in $songs) {
    $n++
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-AmPlaySong -Title ('' + $s.title) -Artist ('' + $s.artist) -SongId ('' + $s.id) -Url ('' + $s.url) `
      -Retries $Retries -PauseFirst -SearchWaitMs 6000 -PageWaitMs 12000
    $elapsed = [int]$sw.ElapsedMilliseconds

    $shotPath = ''
    if (-not $r.ok) {
      $shotPath = Join-Path $shots ('fail-' + $stamp + '-' + $s.id + '-' + $r.attempts + '-' + $r.stage + '.png')
      [void](Save-AmShot $shotPath)
    }

    $rec = [ordered]@{
      songId = $s.id; songTitle = $s.title; songArtist = $s.artist; round = $round; index = $n
      mode = $r.mode; ok = $r.ok; stage = $r.stage; stageHistory = ($r.stageHistory -join '>'); stageDetail = $r.stageDetail
      attempts = $r.attempts
      e2eMs = $elapsed; innerE2eMs = $r.t.e2eMs; smtcMs = $r.t.smtcMs
      realizeMs = $r.t.realizeMs; clickMs = $r.t.clickMs; settleMs = $r.t.settleMs; searchMs = $r.t.searchMs; navigateMs = $(if ($r.navigateMs) { $r.navigateMs } else { 0 })
      candidateCount = $r.candidateCount; ambiguous = $r.ambiguous; pickedByPosition = $r.pickedByPosition; artistFiltered = $r.artistFiltered
      matchedRow = $r.matchedRow; triedCandidates = ($r.triedCandidates -join ' | ')
      baselineStatus = $r.baseline.status; baselineTitle = $r.baseline.title; baselineHasSession = $r.baseline.hasSession
      smtcTitle = $r.smtc.title; smtcArtist = $r.smtc.artist; smtcStatus = $r.smtc.status; smtcPosMs = $r.smtc.posMs
      sawPlaying = $r.smtc.sawPlaying; sawPlayingWrong = $r.smtc.sawPlayingWrong; wrongTitles = ($r.smtc.wrongTitles -join ' | ')
      windowRestored = $r.window.restored; appLaunched = $r.appLaunched; clickRecomputed = $r.clickRecomputed
      firstCandidateFailedButPlayed = $r.firstCandidateFailedButPlayed
      shot = $shotPath; ts = $r.ts; tsMs = $r.tsMs
    }
    Add-AmJsonLine $jsonl $rec
    $records.Add([pscustomobject]$rec)

    $flag = 'FAIL'
    if ($r.ok) { $flag = 'OK  ' }
    Write-Host ('  [' + $n.ToString().PadLeft(3) + '/' + $total + '] ' + $flag + ' ' + $s.id + ' round=' + $round + ' stage=' + $r.stage + ' e2e=' + $elapsed + 'ms smtc=' + $r.t.smtcMs + 'ms attempts=' + $r.attempts + ' mode=' + $r.mode + ' amb=' + $r.ambiguous)
    Start-Sleep -Milliseconds 300
  }
}

# ---------------- summary ----------------
function Get-Stats($values) {
  $v = @($values | Where-Object { $_ -ne $null } | Sort-Object)
  if ($v.Count -eq 0) { return @{ n = 0; mean = 0; median = 0; p95 = 0; max = 0; min = 0 } }
  $sum = 0; foreach ($x in $v) { $sum += $x }
  $idx95 = [Math]::Min($v.Count - 1, [int][Math]::Ceiling($v.Count * 0.95) - 1)
  $median = $v[[int][Math]::Floor($v.Count / 2)]
  if ($v.Count % 2 -eq 0) { $median = [int](($v[$v.Count / 2 - 1] + $v[$v.Count / 2]) / 2) }
  return @{ n = $v.Count; mean = [int]($sum / $v.Count); median = [int]$median; p95 = [int]$v[$idx95]; max = [int]$v[$v.Count - 1]; min = [int]$v[0] }
}

$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $lines.Add($t); Write-Host $t }

Say ('# Stability test ' + $stamp)
Say ''
Say ('- songs: ' + $songs.Count + ', runs per song: ' + $Runs + ', total attempts: ' + $records.Count + ', retries per attempt: ' + $Retries)
Say ('- success criterion: SMTC PlaybackStatus=Playing AND title match (artist match when provided)')
Say ('- before every attempt the session is paused and allowed to settle')
Say ''
$okAll = @($records | Where-Object { $_.ok })
Say ('## Overall success: ' + $okAll.Count + '/' + $records.Count + ' = ' + [math]::Round(100.0 * $okAll.Count / [Math]::Max(1, $records.Count), 1) + '%')
Say ''
Say '## Per song'
Say ''
Say '| song | attempts | success | rate | mean e2e | median | p95 | max | mean smtc | ambiguous | pickedByPosition |'
Say '|---|---|---|---|---|---|---|---|---|---|---|'
foreach ($s in $songs) {
  $sub = @($records | Where-Object { $_.songId -eq $s.id })
  $subOk = @($sub | Where-Object { $_.ok })
  $st = Get-Stats @($subOk | ForEach-Object { $_.e2eMs })
  $sm = Get-Stats @($subOk | ForEach-Object { $_.smtcMs })
  $amb = @($sub | Where-Object { $_.ambiguous }).Count
  $pos = @($sub | Where-Object { $_.pickedByPosition }).Count
  Say ('| ' + $s.id + ' | ' + $sub.Count + ' | ' + $subOk.Count + ' | ' + [math]::Round(100.0 * $subOk.Count / [Math]::Max(1, $sub.Count), 1) + '% | ' + $st.mean + ' ms | ' + $st.median + ' ms | ' + $st.p95 + ' ms | ' + $st.max + ' ms | ' + $sm.mean + ' ms | ' + $amb + ' | ' + $pos + ' |')
}
Say ''
$stAll = Get-Stats @($okAll | ForEach-Object { $_.e2eMs })
$smAll = Get-Stats @($okAll | ForEach-Object { $_.smtcMs })
Say '## Latency of successful attempts (end-to-end = attempt start -> SMTC confirmed)'
Say ''
Say ('- n=' + $stAll.n + '  mean=' + $stAll.mean + ' ms  median=' + $stAll.median + ' ms  p95=' + $stAll.p95 + ' ms  max=' + $stAll.max + ' ms  min=' + $stAll.min + ' ms')
Say ('- SMTC verification segment: mean=' + $smAll.mean + ' ms  median=' + $smAll.median + ' ms  p95=' + $smAll.p95 + ' ms  max=' + $smAll.max + ' ms')
Say ''
Say '## Failure stages'
Say ''
Say '| stage | count | songs |'
Say '|---|---|---|'
foreach ($g in @($records | Where-Object { -not $_.ok } | Group-Object stage | Sort-Object Count -Descending)) {
  $songIds = (@($g.Group | ForEach-Object { $_.songId } | Sort-Object -Unique) -join ',')
  Say ('| ' + $g.Name + ' | ' + $g.Count + ' | ' + $songIds + ' |')
}
Say ''
Say '## Stability signals'
Say ''
Say ('- attempts that needed more than one try: ' + @($records | Where-Object { $_.attempts -gt 1 }).Count)
Say ('- attempts with several title-matching candidates (ambiguous): ' + @($records | Where-Object { $_.ambiguous }).Count + ' (of which decided by list order: ' + @($records | Where-Object { $_.pickedByPosition }).Count + ')')
Say ('- first-choice candidate failed but a later one played: ' + @($records | Where-Object { $_.firstCandidateFailedButPlayed -and $_.ok }).Count)
Say ('- window had to be restored from minimized: ' + @($records | Where-Object { $_.windowRestored }).Count)
Say ('- app had to be launched: ' + @($records | Where-Object { $_.appLaunched }).Count)
Say ('- attempts that saw a wrong track playing at some point: ' + @($records | Where-Object { $_.sawPlayingWrong }).Count)
Say ''
Say '## Modes'
Say ''
foreach ($g in @($records | Group-Object mode)) {
  $gOk = @($g.Group | Where-Object { $_.ok }).Count
  Say ('- ' + $g.Name + ': ' + $gOk + '/' + $g.Count + ' success')
}

# csv
$csvLines = @(($records | Select-Object -First 1 | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name) -join ',')
foreach ($r in $records) {
  $vals = @()
  foreach ($p in ($records | Select-Object -First 1 | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name)) {
    $v = '' + $r.$p
    $v = $v.Replace('"', '""')
    $vals += ('"' + $v + '"')
  }
  $csvLines += ($vals -join ',')
}
Write-AmText $csv ($csvLines -join "`r`n")
Write-AmText $md ($lines -join "`r`n")
Write-Host ''
Write-Host ('report: ' + $md)
Write-Host ('jsonl : ' + $jsonl)
Write-Host ('csv   : ' + $csv)
