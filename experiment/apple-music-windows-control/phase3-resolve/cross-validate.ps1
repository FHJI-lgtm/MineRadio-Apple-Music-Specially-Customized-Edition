# ============================================================
# phase3-resolve/cross-validate.ps1
# Run the resolution research over the cross-validation set: the three verified
# songs plus same-title / cover cases in Chinese and English.
#
# For every case it reports: resolved Apple Music song id, how it was found
# (which strategy step + storefront), whether it matches the independently known
# expectation, and who the runner-up was (typically the cover version).
#
# -VerifyWithUia N : additionally play the first N cases that have a KNOWN id
# through the FROZEN deeplink play chain (poc/lib/am-play.ps1, read-only) using the
# RESOLVED url, and require SMTC to confirm Playing + title + artist. This proves
# the resolved id/url really plays the intended recording. It is a bounded
# validation (default 3), not a batch stability run.
#
# ASCII-only on purpose (case data comes from candidates.json as UTF-8).
# ============================================================
[CmdletBinding()]
param(
  [string]$Storefront = 'cn',
  [int]$VerifyWithUia = 3,
  [string]$CsvOut = ''
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\resolve.ps1')
if ($VerifyWithUia -gt 0) {
  . (Join-Path $PSScriptRoot '..\poc\lib\am-smtc.ps1')
  . (Join-Path $PSScriptRoot '..\poc\lib\am-uia.ps1')
  . (Join-Path $PSScriptRoot '..\poc\lib\am-play.ps1')
}

$findings = Join-Path $PSScriptRoot '..\findings\phase3'
if (-not (Test-Path $findings)) { New-Item -ItemType Directory -Force -Path $findings | Out-Null }
$stamp = Get-AmStamp
$jsonl = Join-Path $findings ('cross-validate-' + $stamp + '.jsonl')
$md = Join-Path $findings ('cross-validate-' + $stamp + '.md')
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $lines.Add($t); Write-Host $t }

$cfg = Get-Content -Path (Join-Path $PSScriptRoot 'candidates.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cases = @($cfg.cases)
Say ('# Cross-validation ' + $stamp)
Say ''
Say ('input: title / artist / album  ->  resolver  ->  Apple Music song id + url   (storefront=' + $Storefront + ')')
Say ''
Say '| case | input | resolved id | verdict | via | matched artist | matched album | runner-up (cover?) |'
Say '|---|---|---|---|---|---|---|---|'

$ok = 0; $bad = 0; $edition = 0
$rows = @()
$verified = 0
foreach ($c in $cases) {
  $res = Resolve-AmSongId -Title ('' + $c.title) -Artist ('' + $c.artist) -Album ('' + $c.album) -Storefront $Storefront
  $idMatch = ''
  $artistMatch = $false
  $albumMatch = $true
  if ($c.expectId) { $idMatch = ($res.songId -eq ('' + $c.expectId)) }
  if ($c.expectArtist) { $artistMatch = (Test-AmArtistLooseMatch ('' + $c.expectArtist) ('' + $res.matchedArtist)) }
  if ($c.album -and $res.matchedAlbum) {
    $normA = Normalize-AmText ('' + $res.matchedAlbum)
    $normB = Normalize-AmText ('' + $c.album)
    $albumMatch = ($normA -eq $normB -or $normA.Contains($normB) -or $normB.Contains($normA))
  }
  # verdict:
  #   PASS    = the exact verified Apple Music id (or, without one, artist+album match)
  #   EDITION = same title + artist + album, but a DIFFERENT trackId: the same song as
  #             released on another edition/compilation (a real resolution outcome,
  #             not a wrong answer - the caller wanted "this song")
  #   FAIL    = something else was matched
  $verdict = 'FAIL'
  if ($res.ok) {
    $titleOk = Test-AmSmtcTitleMatch ('' + $res.matchedTitle) ('' + $c.title)
    if ($c.expectId) {
      if (($idMatch -eq $true) -and $artistMatch) { $verdict = 'PASS' }
      elseif ($artistMatch -and $albumMatch -and $titleOk) { $verdict = 'EDITION' }
    } else {
      if ($artistMatch -and $albumMatch -and $titleOk) { $verdict = 'PASS' }
    }
  }
  if ($verdict -eq 'PASS') { $ok++ } elseif ($verdict -eq 'EDITION') { $edition++ } else { $bad++ }
  $pass = ($verdict -ne 'FAIL')   # EDITION and PASS both count as a usable resolution
  $input = ('' + $c.title + ' / ' + $c.artist + $(if ($c.album) { ' / ' + $c.album } else { '' }))
  $runner = ('' + $res.runnerUpArtist + ' - ' + $res.runnerUpTitle)
  Say ('| ' + $c.id + ' | ' + $input + ' | ' + $res.songId + ' | ' + $verdict + ' | ' + $res.viaKind + '/sf=' + $res.viaStorefront + ' | ' + $res.matchedArtist + ' | ' + $res.matchedAlbum + ' | ' + (Truncate-AmText $runner 44) + ' |')

  $uia = @{ attempted = $false; ok = $false; stage = ''; smtcTitle = ''; smtcArtist = '' }
  if ($VerifyWithUia -gt 0 -and $pass -and $c.expectId -and $verified -lt $VerifyWithUia) {
    $verified++
    $pr = Invoke-AmPlaySong -Title ('' + $c.title) -Artist ('' + $c.expectArtist) -SongId ('' + $c.id) -Url $res.songUrl -Retries 1 -PauseFirst
    $uia = @{ attempted = $true; ok = $pr.ok; stage = $pr.stage; smtcTitle = $pr.smtc.title; smtcArtist = $pr.smtc.artist; e2eMs = $pr.t.e2eMs; url = $res.songUrl }
    Say ('  - UIA/SMTC check on the RESOLVED url: ok=' + $pr.ok + ' stage=' + $pr.stage + ' smtc="' + $pr.smtc.title + '" / "' + $pr.smtc.artist + '" e2e=' + $pr.t.e2eMs + 'ms')
  }

  $row = [ordered]@{
    case = $c.id; taggedAs = $c.taggedAs; title = $c.title; artist = $c.artist; album = $c.album
    ok = $res.ok; pass = $pass; verdict = $verdict
    resolvedId = $res.songId; expectId = ('' + $c.expectId); idMatch = $idMatch
    artistMatch = $artistMatch; albumMatch = $albumMatch
    viaKind = $res.viaKind; viaStorefront = $res.viaStorefront; viaTerm = $res.viaTerm; score = $res.score
    matchedTitle = $res.matchedTitle; matchedArtist = $res.matchedArtist; matchedAlbum = $res.matchedAlbum
    runnerUpId = $res.runnerUpId; runnerUpArtist = $res.runnerUpArtist; runnerUpTitle = $res.runnerUpTitle
    canonicalUrl = $res.songUrl; trackViewUrl = $res.trackViewUrl
    uiaAttempted = $uia.attempted; uiaOk = $uia.ok; uiaStage = $uia.stage; uiaSmtcTitle = $uia.smtcTitle; uiaSmtcArtist = $uia.smtcArtist
    ts = (Get-AmIsoNow)
  }
  Add-AmJsonLine $jsonl $row
  $rows += , $row
  Start-Sleep -Milliseconds 200
}

Say ''
Say ('## Resolution outcome: PASS (exact verified id / artist+album) = ' + $ok + ', EDITION (same song on another release) = ' + $edition + ', FAIL = ' + $bad + '   [total ' + $cases.Count + ']')
Say ('- usable resolutions (PASS + EDITION) = ' + ($ok + $edition) + '/' + $cases.Count + ' = ' + [math]::Round(100.0 * ($ok + $edition) / [Math]::Max(1, $cases.Count), 1) + '%')
if ($VerifyWithUia -gt 0) {
  $uiaRows = @($rows | Where-Object { $_.uiaAttempted })
  $uiaOk = @($uiaRows | Where-Object { $_.uiaOk }).Count
  Say ('- UIA/SMTC confirmation of resolved urls: ' + $uiaOk + '/' + $uiaRows.Count)
}
Say ''
Say '## Per case notes'
Say ''
foreach ($r in $rows) {
  Say ('- ' + $r.case + ' [' + $r.taggedAs + '] -> ' + $r.verdict + '  resolved=' + $r.resolvedId + '  matched="' + $r.matchedArtist + '"  runnerUp="' + $r.runnerUpArtist + '"')
}

Write-AmText $md ($lines -join "`r`n")
if ($CsvOut) { Write-AmText $CsvOut (($rows | ConvertTo-Csv -NoTypeInformation) -join "`r`n") }
Write-Host ''
Write-Host ('report: ' + $md)
Write-Host ('jsonl : ' + $jsonl)
