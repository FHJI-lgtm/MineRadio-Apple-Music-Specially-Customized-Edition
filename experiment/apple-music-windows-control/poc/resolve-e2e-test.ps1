# ============================================================
# poc/resolve-e2e-test.ps1
# Phase 3.6 resolve -> playback E2E.
# Per song: Title + Artist (+ Album) -> Resolve-AmSong -> songId -> canonical URL
# -> FROZEN phase 2 chain (AppleMusic.exe /url -> UIA -> realize -> safe double
# click -> SMTC).  No URL is supplied by the test data.
#
# This runner only *collects* raw per-song rows.  Every metric (rates, wrong
# acceptances, latency percentiles) is derived by poc/analyze-e2e.ps1, which is
# the single source of truth - the runner no longer prints its own numbers.
#
# Playback files are only dot-sourced, never modified.
# ASCII-only file; all song text lives in phase35-cases.json (UTF-8).
# ============================================================
[CmdletBinding()]
param(
  [string]$Only = '',            # optional comma list of case ids
  [int]$SleepMs = 800,
  [switch]$NoPlay,
  [switch]$NoAnalyze
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot 'lib\am-uia.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play.ps1')
. (Join-Path $PSScriptRoot '..\phase3-resolve\lib\resolve35.ps1')

$findings = Join-Path $PSScriptRoot '..\findings\phase3'
if (-not (Test-Path $findings)) { New-Item -ItemType Directory -Force -Path $findings | Out-Null }
$stamp = Get-AmStamp
$jsonl = Join-Path $findings ('e2e-' + $stamp + '.jsonl')

$cases = @((Get-Content -Path (Join-Path $PSScriptRoot '..\phase3-resolve\phase35-cases.json') -Raw -Encoding UTF8 | ConvertFrom-Json).e2eSongs)
if ($Only -ne '') { $want = $Only.Split(','); $cases = @($cases | Where-Object { $want -contains $_.id }) }

Write-Host ('# Phase 3.6 resolve -> playback E2E ' + $stamp)
Write-Host ('cases=' + $cases.Count + ' (text only in, no pre-supplied URL)')
Write-Host ''
Write-Host '| id | tag | requested | resolve | conf | auto | songId | storefront | resolveMs | playback | stage | e2eMs | smtc title / artist |'
Write-Host '|---|---|---|---|---|---|---|---|---|---|---|---|---|'

foreach ($c in $cases) {
  $title = '' + $c.title; $artist = '' + $c.artist; $album = '' + $c.album
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $rargs = @{ Title = $title; Artist = $artist; Storefront = 'cn' }
  if ($album -ne '') { $rargs['Album'] = $album }
  $r = Resolve-AmSong @rargs
  $resolveMs = [int]$sw.ElapsedMilliseconds

  $resolveOk = [bool]$r.ok
  $auto = [bool]$r.autoPlayable
  $conf = '' + $r.confidence
  $vLayer = '' + $r.version.layer
  $code = 'OK'
  if (-not $resolveOk) {
    $code = '' + $r.reason
    if ($code -eq '') { $code = 'RESOLVE_NOT_FOUND' }
  } elseif (-not $auto) {
    # resolver policy: a LOW-confidence result, or a non-canonical-only version,
    # is reported but never auto-played
    if ($conf -eq 'LOW') { $code = 'RESOLVE_LOW_CONFIDENCE' } else { $code = 'RESOLVE_NONCANONICAL_ONLY' }
    $resolveOk = $false
  }
  if (('' + $r.confidence) -eq 'AMBIGUOUS') { $code = 'RESOLVE_AMBIGUOUS'; $resolveOk = $false }

  $playback = 'SKIPPED'
  $stage = $code
  $smtcTitle = ''; $smtcArtist = ''; $smtcMs = 0; $playbackMs = 0
  $navMethod = ''; $matchedRow = ''; $stageDetail = ''
  if ($resolveOk -and -not $NoPlay) {
    $beforePlay = [int]$sw.ElapsedMilliseconds
    $r2 = Invoke-AmPlaySong -Title $title -Artist $artist -SongId ('' + $r.songId) -Url ('' + $r.canonicalUrl) -Retries 1 -PauseFirst
    # am-play exposes no playback-only duration: derive it from the stopwatch
    $playbackMs = [Math]::Max(0, [int]$sw.ElapsedMilliseconds - $beforePlay)
    $stage = '' + $r2.stage
    $playback = 'FAIL'
    if ($r2.ok) { $playback = 'OK' }
    $smtcTitle = '' + $r2.smtc.title; $smtcArtist = '' + $r2.smtc.artist; $smtcMs = [int]$r2.t.smtcMs
    $navMethod = '' + $r2.navMethod; $matchedRow = '' + $r2.matchedRow; $stageDetail = '' + $r2.stageDetail
  }

  $evArtist = '' + $r.lookup.artist
  if ($evArtist -eq '') { $evArtist = '' + $r.matched.artist }
  $rawArtistScore = -1
  if ($resolveOk -and $artist -ne '' -and $evArtist -ne '') { $rawArtistScore = [int](Test-AmArtistLayer $artist $evArtist).score }

  $row = [ordered]@{
    id = $c.id; tag = $c.tag; title = $title; artist = $artist; album = $album
    resolveOk = $resolveOk; code = $code; reason = ('' + $r.reason); confidence = $conf; autoPlayable = $auto
    versionLayer = $vLayer; versionClasses = ($r.version.classes -join ','); versionCanonical = [bool]$r.version.canonical
    versionRequestClasses = ($r.version.requestClasses -join ',')
    songId = ('' + $r.songId); storefront = ('' + $r.storefront); canonicalUrl = ('' + $r.canonicalUrl); slug = ('' + $r.slug)
    matchedTrackId = ('' + $r.matched.trackId); matchedTitle = ('' + $r.matched.title); matchedArtist = ('' + $r.matched.artist); matchedAlbum = ('' + $r.matched.album)
    albumLayer = ('' + $r.matched.albumLayer); artistLayer = ('' + $r.matched.artistLayer); rawArtistLayerScore = $rawArtistScore
    runnerUpId = ('' + $r.runnerUp.songId); runnerUpTitle = ('' + $r.runnerUp.title); runnerUpAlbum = ('' + $r.runnerUp.album); runnerUpScore = $r.runnerUp.score
    lookupPerformed = [bool]$r.lookup.performed; lookupOk = [bool]$r.lookup.ok; lookupStorefront = ('' + $r.lookup.storefront)
    lookupTitle = ('' + $r.lookup.title); lookupArtist = ('' + $r.lookup.artist); lookupAlbum = ('' + $r.lookup.album)
    poolSize = $r.candidateCount; totalCandidates = $r.totalCandidates
    ambiguous = [bool]$r.ambiguous; tie = [bool]$r.tie; distinctRecordings = $r.distinctRecordings
    choseCanonical = [bool]$r.choseCanonical; selectionNotes = ($r.selectionNotes -join '; ')
    playback = $playback; stage = $stage; stageDetail = $stageDetail
    resolveMs = $resolveMs; playbackMs = $playbackMs; e2eMs = [int]$sw.ElapsedMilliseconds
    smtcTitle = $smtcTitle; smtcArtist = $smtcArtist; smtcMs = $smtcMs; navMethod = $navMethod; matchedRow = $matchedRow
    ts = (Get-AmIsoNow)
  }
  Add-AmJsonLine $jsonl $row
  Write-Host ('| ' + $c.id + ' | ' + $c.tag + ' | ' + $title + ' / ' + $artist + ' / ' + $album + ' | ' + $resolveOk + ' | ' + $conf + ' | ' + $auto + ' | ' + $r.songId + ' | ' + $r.storefront + ' | ' + $resolveMs + ' | ' + $playback + ' | ' + $stage + ' | ' + $row.e2eMs + ' | ' + $smtcTitle + ' / ' + $smtcArtist + ' |')
  Start-Sleep -Milliseconds $SleepMs
}

Write-Host ''
Write-Host ('raw rows: ' + $jsonl)
if (-not $NoAnalyze) {
  # metrics come from the auditor only - this runner makes no claims of its own
  $summary = & (Join-Path $PSScriptRoot 'analyze-e2e.ps1') -Jsonl $jsonl -OutDir $findings -Label 'e2e'
  if ($summary.hardFailure) { exit 1 }
}
