# ============================================================
# poc/resolve-test.ps1   (Phase 3.5 resolver unit tests)
# Runs phase3-resolve/lib/resolve35.ps1 over the unitCases in
# phase3-resolve/phase35-cases.json. No App, no playback - pure resolution.
#
# Verdict vocabulary (as requested):
#   PASS              exact expected id, or artist(+album) match when no id is known
#   EDITION_MISMATCH  an album was requested and the resolved album is not that album
#   FAIL              the wrong artist (or an otherwise unacceptable candidate) was returned
#   AMBIGUOUS         the resolver refused to choose (safe outcome)
#   NOT_FOUND         nothing acceptable was found (safe outcome)
#
# Also records the error classification requested for Phase 3.5.
# ASCII-only on purpose (all titles come from JSON as UTF-8).
# ============================================================
[CmdletBinding()]
param([string]$Storefront = 'cn')

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot '..\phase3-resolve\lib\resolve35.ps1')

$findings = Join-Path $PSScriptRoot '..\findings\phase3'
if (-not (Test-Path $findings)) { New-Item -ItemType Directory -Force -Path $findings | Out-Null }
$stamp = Get-AmStamp
$jsonOut = Join-Path $findings ('resolve-test-' + $stamp + '.json')
$md = Join-Path $findings ('resolve-test-' + $stamp + '.md')

$cfg = Get-Content -Path (Join-Path $PSScriptRoot '..\phase3-resolve\phase35-cases.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cases = @($cfg.unitCases)
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $lines.Add($t); Write-Host $t }

Say ('# Resolver unit tests ' + $stamp)
Say ''
Say '| case | input | verdict | confidence | resolved id | matched artist | matched album | error |'
Say '|---|---|---|---|---|---|---|---|'

$verdicts = @{}
$reports = @()
foreach ($c in $cases) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = Resolve-AmSong -Title ('' + $c.title) -Artist ('' + $c.artist) -Album ('' + $c.album) -Storefront $Storefront
  $ms = [int]$sw.ElapsedMilliseconds

  $verdict = 'FAIL'; $errCode = ''
  if (-not $r.ok) {
    if ($r.reason -eq 'RESOLVE_AMBIGUOUS') { $verdict = 'AMBIGUOUS'; $errCode = 'RESOLVE_AMBIGUOUS' }
    else { $verdict = 'NOT_FOUND'; $errCode = 'RESOLVE_NOT_FOUND' }
  } else {
    $artistOk = $true
    if ($c.artist) { $artistOk = (Test-AmArtistLayer ('' + $c.artist) ('' + $r.matched.artist)).ok }
    $albumOk = $true
    if ($c.album) { $albumOk = (Get-AmAlbumLayer ('' + $c.album) ('' + $r.matched.album)).exact }
    if (-not $artistOk) { $verdict = 'FAIL'; $errCode = 'RESOLVE_WRONG_ARTIST' }
    elseif (-not $albumOk) { $verdict = 'EDITION_MISMATCH'; $errCode = 'RESOLVE_WRONG_ALBUM' }
    elseif ($c.expectId -and ($r.songId -ne ('' + $c.expectId))) { $verdict = 'PASS'; $errCode = '' ; $note = 'same artist+album, different release id' }
    else { $verdict = 'PASS' }
    if ($r.lookup.performed -and -not $r.lookup.ok) { $errCode = 'LOOKUP_FAILED' }
  }
  if (-not $verdicts.ContainsKey($verdict)) { $verdicts[$verdict] = 0 }
  $verdicts[$verdict] = $verdicts[$verdict] + 1

  $inputTxt = ('' + $c.title + ' / ' + $c.artist + $(if ($c.album) { ' / ' + $c.album } else { '' }))
  Say ('| ' + $c.id + ' | ' + (Truncate-AmText $inputTxt 46) + ' | ' + $verdict + ' | ' + $r.confidence + ' | ' + $r.songId + ' | ' + $r.matched.artist + ' | ' + $r.matched.album + ' | ' + $errCode + ' |')
  $reports += , [ordered]@{
    case = $c.id; tag = $c.tag; title = $c.title; artist = $c.artist; album = $c.album; expectId = ('' + $c.expectId)
    verdict = $verdict; error = $errCode; confidence = $r.confidence; reason = $r.reason
    songId = $r.songId; storefront = $r.storefront; resolveMs = $ms
    matchedTitle = $r.matched.title; matchedArtist = $r.matched.artist; matchedAlbum = $r.matched.album
    titleLayer = $r.matched.titleLayer; artistLayer = $r.matched.artistLayer; albumLayer = $r.matched.albumLayer
    runnerUpId = $r.runnerUp.songId; runnerUpArtist = $r.runnerUp.artist; runnerUpAlbum = $r.runnerUp.album
    lookupOk = $r.lookup.ok; lookupStorefront = $r.lookup.storefront; lookupInRequested = $r.lookup.inRequested
    canonicalUrl = $r.canonicalUrl; candidateCount = $r.candidateCount
  }
}

$usable = 0
foreach ($k in @('PASS', 'EDITION_MISMATCH')) { if ($verdicts.ContainsKey($k)) { $usable += $verdicts[$k] } }
Say ''
Say '## Verdicts'
Say ''
foreach ($k in @('PASS', 'EDITION_MISMATCH', 'FAIL', 'AMBIGUOUS', 'NOT_FOUND')) {
  $n = 0
  if ($verdicts.ContainsKey($k)) { $n = $verdicts[$k] }
  Say ('- ' + $k + ': ' + $n)
}
Say ''
Say ('- usable (PASS + EDITION_MISMATCH): ' + $usable + '/' + $cases.Count + ' = ' + [math]::Round(100.0 * $usable / [Math]::Max(1, $cases.Count), 1) + '%')
Say ('- resolver-level failure (FAIL + AMBIGUOUS + NOT_FOUND): ' + ($cases.Count - $usable))
$wrongArtist = @($reports | Where-Object { $_.error -eq 'RESOLVE_WRONG_ARTIST' }).Count
Say ('- **wrong-artist acceptances (must be 0): ' + $wrongArtist + '**')
$idOk = @($reports | Where-Object { $_.expectId -and $_.songId -eq $_.expectId }).Count
$idCases = @($reports | Where-Object { $_.expectId }).Count
Say ('- exact-id cases: ' + $idOk + '/' + $idCases)
$lookupOk = @($reports | Where-Object { $_.lookupOk }).Count
Say ('- lookup-validated: ' + $lookupOk + '/' + $cases.Count)

Write-AmText $jsonOut (($reports | ConvertTo-Json -Depth 6))
Write-AmText $md ($lines -join "`r`n")
Write-Host ''
Write-Host ('json: ' + $jsonOut)
Write-Host ('md  : ' + $md)
