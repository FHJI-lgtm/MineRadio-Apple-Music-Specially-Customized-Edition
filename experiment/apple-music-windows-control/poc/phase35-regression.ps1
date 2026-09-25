# ============================================================
# poc/phase35-regression.ps1
# Phase 3.5 step 1: Phase 2 FROZEN playback regression.
# Uses ONLY the three known-correct Phase 2 URLs (5 runs each = 15) and goes
# straight through the frozen chain: AppleMusic.exe /url -> UIA -> realize ->
# safe double click -> SMTC. The resolver is NOT involved at all.
# ASCII-only on purpose (song data comes from known-songs.json as UTF-8).
# ============================================================
[CmdletBinding()]
param([int]$Runs = 5)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot 'lib\am-uia.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play.ps1')

$findings = Join-Path $PSScriptRoot '..\findings\phase3'
if (-not (Test-Path $findings)) { New-Item -ItemType Directory -Force -Path $findings | Out-Null }
$stamp = Get-AmStamp
$jsonl = Join-Path $findings ('regression-' + $stamp + '.jsonl')
$md = Join-Path $findings ('regression-' + $stamp + '.md')
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $lines.Add($t); Write-Host $t }

$songs = @((Get-Content -Path (Join-Path $PSScriptRoot '..\phase3-resolve\known-songs.json') -Raw -Encoding UTF8 | ConvertFrom-Json).songs)
Say ('# Phase 2 frozen playback regression ' + $stamp)
Say ('known URLs only, no resolver: ' + $songs.Count + ' songs x ' + $Runs + ' = ' + ($songs.Count * $Runs) + ' plays')
Say ''
Say '| song | run | ok | stage | e2eMs | smtcMs | smtc title / artist |'
Say '|---|---|---|---|---|---|---|'

$recs = @()
$n = 0
foreach ($s in $songs) {
  for ($i = 1; $i -le $Runs; $i++) {
    $n++
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-AmPlaySong -Title ('' + $s.title) -Artist ('' + $s.artist) -SongId ('' + $s.id) -Url ('' + $s.verifiedUrl) -Retries 0 -PauseFirst
    $ms = [int]$sw.ElapsedMilliseconds
    $rec = [ordered]@{
      song = $s.id; run = $i; ok = $r.ok; stage = $r.stage; e2eMs = $ms; smtcMs = $r.t.smtcMs
      resolveMs = 0; url = $s.verifiedUrl; mode = $r.mode; navMethod = $r.navMethod
      smtcTitle = $r.smtc.title; smtcArtist = $r.smtc.artist; matchedRow = $r.matchedRow; stageDetail = $r.stageDetail; ts = $r.ts
    }
    $recs += , $rec
    Add-AmJsonLine $jsonl $rec
    Say ('| ' + $s.id + ' | ' + $i + ' | ' + $r.ok + ' | ' + $r.stage + ' | ' + $ms + ' | ' + $r.t.smtcMs + ' | ' + $r.smtc.title + ' / ' + $r.smtc.artist + ' |')
    Start-Sleep -Milliseconds 300
  }
}

function Get-Stats($values) {
  $v = @($values | Sort-Object)
  if ($v.Count -eq 0) { return @{ n = 0; mean = 0; median = 0; p95 = 0; max = 0 } }
  $sum = 0; foreach ($x in $v) { $sum += $x }
  $med = $v[[int][Math]::Floor(($v.Count - 1) / 2)]
  $idx95 = [Math]::Min($v.Count - 1, [int][Math]::Ceiling($v.Count * 0.95) - 1)
  return @{ n = $v.Count; mean = [int]($sum / $v.Count); median = [int]$med; p95 = [int]$v[$idx95]; max = [int]$v[$v.Count - 1] }
}
$okRecs = @($recs | Where-Object { $_.ok })
$st = Get-Stats @($okRecs | ForEach-Object { $_.e2eMs })
Say ''
Say ('## Result: ' + $okRecs.Count + '/' + $recs.Count + ' success')
Say ('- e2e: mean=' + $st.mean + 'ms median=' + $st.median + 'ms p95=' + $st.p95 + 'ms max=' + $st.max + 'ms')
foreach ($code in @('SMTC_WRONG_TRACK', 'SMTC_TIMEOUT', 'TARGET_ROW_NOT_FOUND', 'CLICK_FAILED', 'REALIZE_FAILED', 'URL_NAVIGATION_FAILED', 'BOUNDS_INVALID', 'APP_NOT_RUNNING')) {
  $c = @($recs | Where-Object { $_.stage -eq $code }).Count
  Say ('- ' + $code + ' = ' + $c)
}
Write-AmText $md ($lines -join "`r`n")
$summary = @{ stamp = $stamp; total = $recs.Count; success = $okRecs.Count; zeroFailureCodes = (@($recs | Where-Object { $_.stage -ne 'OK' }).Count -eq 0); e2e = $st }
Write-AmJsonFile (Join-Path $findings ('regression-' + $stamp + '-summary.json')) $summary
Write-Host ''
Write-Host ('report: ' + $md)
