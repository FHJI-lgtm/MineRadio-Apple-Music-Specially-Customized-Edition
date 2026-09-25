# ============================================================
# poc/resolve-e2e-test.ps1
# Phase 3.5 step 2: resolve -> playback end-to-end test.
# Per song: Title + Artist (+ Album) -> Resolve-AmSong (phase35 resolver) ->
# songId -> canonical URL -> FROZEN phase 2 chain (AppleMusic.exe /url -> UIA
# -> realize -> safe double click -> SMTC). No URL is supplied by the test data.
# The frozen playback files are only dot-sourced, never modified.
# ASCII-only file; all song text lives in phase35-cases.json (UTF-8).
# ============================================================
[CmdletBinding()]
param(
  [string]$Only = '',            # optional comma list of case ids
  [int]$SleepMs = 800,           # pause between songs to be kind to the public API
  [switch]$NoPlay                # resolve-only dry pass
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
$md = Join-Path $findings ('e2e-' + $stamp + '.md')
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $lines.Add($t); Write-Host $t }

$cases = @((Get-Content -Path (Join-Path $PSScriptRoot '..\phase3-resolve\phase35-cases.json') -Raw -Encoding UTF8 | ConvertFrom-Json).e2eSongs)
if ($Only -ne '') { $want = $Only.Split(','); $cases = @($cases | Where-Object { $want -contains $_.id }) }

Say ('# Phase 3.5 resolve -> playback E2E ' + $stamp)
Say ('cases=' + $cases.Count + ' (all text passed in, no pre-supplied URL)')
Say ''
Say '| id | tag | requested | resolve | conf | songId | storefront | resolveMs | playback | stage | e2eMs | smtc title / artist |'
Say '|---|---|---|---|---|---|---|---|---|---|---|---|'

$recs = @()
foreach ($c in $cases) {
  $title = '' + $c.title; $artist = '' + $c.artist; $album = '' + $c.album
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $rargs = @{ Title = $title; Artist = $artist; Storefront = 'cn' }
  if ($album -ne '') { $rargs['Album'] = $album }
  $r = Resolve-AmSong @rargs
  $resolveMs = [int]$sw.ElapsedMilliseconds

  $reason = '' + $r.reason
  $conf = '' + $r.confidence
  $resolveOk = [bool]$r.ok
  $code = 'OK'

  if (-not $resolveOk) {
    $code = $reason
  } elseif ($conf -eq 'LOW') {
    # Step 3 policy: a LOW confidence candidate must never be auto-played.
    $resolveOk = $false
    if ($r.lookup.performed -and -not $r.lookup.ok) { $code = 'LOOKUP_FAILED' } else { $code = 'RESOLVE_LOW_CONFIDENCE' }
  }
  if ($resolveOk -and $conf -eq 'AMBIGUOUS') { $code = 'RESOLVE_AMBIGUOUS' }

  # honest audit of what the accepted candidate actually claims to be
  $resolvedArtist = '' + $r.lookup.artist
  if ($resolvedArtist -eq '') { $resolvedArtist = '' + $r.matched.artist }
  $resolvedAlbum = '' + $r.lookup.album
  if ($resolvedAlbum -eq '') { $resolvedAlbum = '' + $r.matched.album }
  $artistLayer = -1
  if ($resolveOk -and $resolvedArtist -ne '') { $artistLayer = Test-AmArtistLayer $artist $resolvedArtist }
  $wrongArtist = $false
  if ($resolveOk -and $artistLayer -eq 0) { $wrongArtist = $true }
  $editionDifferent = $false
  if ($resolveOk -and $album -ne '' -and $resolvedAlbum -ne '') {
    $al = Get-AmAlbumLayer $album $resolvedAlbum
    if ($al -le 0) {
      $na = Normalize-AmText $album; $nb = Normalize-AmText $resolvedAlbum
      if ($nb -notlike ('*' + $na + '*') -and $na -notlike ('*' + $nb + '*')) { $editionDifferent = $true }
    }
  }

  $playback = 'SKIPPED'
  $stage = $code
  $smtcTitle = ''; $smtcArtist = ''; $playMs = 0
  if ($resolveOk -and -not $NoPlay) {
    $r2 = Invoke-AmPlaySong -Title $title -Artist $artist -SongId ('' + $r.songId) -Url ('' + $r.canonicalUrl) -Retries 1 -PauseFirst
    $playMs = [int]$r2.t.totalMs
    $stage = '' + $r2.stage
    $playback = 'FAIL'
    if ($r2.ok) { $playback = 'OK' }
    $smtcTitle = '' + $r2.smtc.title; $smtcArtist = '' + $r2.smtc.artist
    if ($playback -eq 'OK' -and $artist -ne '' -and -not (Test-AmSmtcArtistMatch $artist $smtcArtist)) { $wrongArtist = $true }
  } elseif (-not $resolveOk) {
    $stage = $code
  } else { $stage = 'RESOLVE_ONLY' }

  $e2eMs = [int]$sw.ElapsedMilliseconds
  $rec = [ordered]@{
    id = $c.id; tag = $c.tag; title = $title; artist = $artist; album = $album
    resolveOk = $resolveOk; code = $code; confidence = $conf; strategy = ('' + $r.strategy); score = $r.score
    songId = ('' + $r.songId); storefront = ('' + $r.storefront); canonicalUrl = ('' + $r.canonicalUrl); slug = ('' + $r.slug)
    matchedTitle = ('' + $r.matched.title); matchedArtist = $resolvedArtist; matchedAlbum = $resolvedAlbum; artistLayer = $artistLayer
    runnerUpId = ('' + $r.runnerUp.songId); runnerUpTitle = ('' + $r.runnerUp.title); runnerUpArtist = ('' + $r.runnerUp.artist); runnerUpAlbum = ('' + $r.runnerUp.album); runnerUpScore = $r.runnerUp.score
    lookupPerformed = [bool]$r.lookup.performed; lookupOk = [bool]$r.lookup.ok; lookupStorefront = ('' + $r.lookup.storefront)
    candidateCount = $r.candidateCount; evidence = ($r.evidence -join ' | ')
    playback = $playback; stage = $stage; resolveMs = $resolveMs; playbackMs = $playMs; e2eMs = $e2eMs
    smtcTitle = $smtcTitle; smtcArtist = $smtcArtist
    wrongArtistAcceptance = $wrongArtist; editionDifferent = $editionDifferent; ts = (Get-AmIsoNow)
  }
  $recs += , $rec
  Add-AmJsonLine $jsonl $rec
  Say ('| ' + $c.id + ' | ' + $c.tag + ' | ' + $title + ' / ' + $artist + ' / ' + $album + ' | ' + $resolveOk + ' | ' + $conf + ' | ' + $r.songId + ' | ' + $r.storefront + ' | ' + $resolveMs + ' | ' + $playback + ' | ' + $stage + ' | ' + $e2eMs + ' | ' + $smtcTitle + ' / ' + $smtcArtist + ' |')
  Start-Sleep -Milliseconds $SleepMs
}

function Get-Stats($values) {
  $v = @($values | Sort-Object)
  if ($v.Count -eq 0) { return @{ n = 0; mean = 0; p50 = 0; p95 = 0; max = 0 } }
  $sum = 0; foreach ($x in $v) { $sum += $x }
  $p50 = $v[[int][Math]::Floor(($v.Count - 1) * 0.5)]
  $i95 = [Math]::Min($v.Count - 1, [int][Math]::Ceiling($v.Count * 0.95) - 1)
  return @{ n = $v.Count; mean = [int]($sum / $v.Count); p50 = [int]$p50; p95 = [int]$v[$i95]; max = [int]$v[$v.Count - 1] }
}

$total = $recs.Count
$resolved = @($recs | Where-Object { $_.resolveOk })
$played = @($recs | Where-Object { $_.playback -ne 'SKIPPED' })
$playOk = @($played | Where-Object { $_.playback -eq 'OK' })
$e2eOk = @($playOk)
$wrongArtist = @($recs | Where-Object { $_.wrongArtistAcceptance })
$editionDiff = @($recs | Where-Object { $_.editionDifferent })

$taxonomy = @('RESOLVE_NOT_FOUND', 'RESOLVE_AMBIGUOUS', 'RESOLVE_WRONG_ARTIST', 'RESOLVE_WRONG_ALBUM', 'RESOLVE_LOW_CONFIDENCE', 'LOOKUP_FAILED', 'URL_NAVIGATION_FAILED', 'TARGET_ROW_NOT_FOUND', 'REALIZE_FAILED', 'BOUNDS_INVALID', 'CLICK_FAILED', 'SMTC_TIMEOUT', 'SMTC_WRONG_TRACK', 'APP_NOT_RUNNING')
Say ''
Say '## Counts'
Say ('- resolve success: ' + $resolved.Count + '/' + $total + ' = ' + [int](100 * $resolved.Count / [Math]::Max(1, $total)) + '%')
Say ('- playback attempted: ' + $played.Count + ', playback success: ' + $playOk.Count + '/' + $played.Count + ' = ' + [int](100 * $playOk.Count / [Math]::Max(1, $played.Count)) + '%')
Say ('- overall E2E success: ' + $e2eOk.Count + '/' + $total + ' = ' + [int](100 * $e2eOk.Count / [Math]::Max(1, $total)) + '%')
Say ('- wrong-artist acceptances: ' + $wrongArtist.Count)
Say ('- wrong/different edition accepted: ' + $editionDiff.Count + ' (' + (($editionDiff | ForEach-Object { $_.id }) -join ',') + ')')
Say ''
Say '## Failure taxonomy'
foreach ($t in $taxonomy) { Say ('- ' + $t + ' = ' + @($recs | Where-Object { $_.stage -eq $t }).Count) }
Say ''
$rs = Get-Stats @($recs | ForEach-Object { $_.resolveMs })
$ps = Get-Stats @($played | ForEach-Object { $_.playbackMs })
$es = Get-Stats @($recs | ForEach-Object { $_.e2eMs })
Say '## Latency'
Say ('- resolve  p50=' + $rs.p50 + 'ms p95=' + $rs.p95 + 'ms max=' + $rs.max + 'ms mean=' + $rs.mean + 'ms')
Say ('- playback p50=' + $ps.p50 + 'ms p95=' + $ps.p95 + 'ms max=' + $ps.max + 'ms mean=' + $ps.mean + 'ms')
Say ('- overall  p50=' + $es.p50 + 'ms p95=' + $es.p95 + 'ms max=' + $es.max + 'ms mean=' + $es.mean + 'ms')

Write-AmText $md ($lines -join "`r`n")
$summary = [ordered]@{
  stamp = $stamp; total = $total; resolveSuccess = $resolved.Count; playbackAttempted = $played.Count
  playbackSuccess = $playOk.Count; e2eSuccess = $e2eOk.Count; wrongArtistAcceptances = $wrongArtist.Count
  editionDifferent = $editionDiff.Count; resolveMs = $rs; playbackMs = $ps; e2eMs = $es
}
$tax = @{}
foreach ($t in $taxonomy) { $tax[$t] = @($recs | Where-Object { $_.stage -eq $t }).Count }
$summary['taxonomy'] = $tax
Write-AmJsonFile (Join-Path $findings ('e2e-' + $stamp + '-summary.json')) $summary
Write-Host ''
Write-Host ('report: ' + $md)
