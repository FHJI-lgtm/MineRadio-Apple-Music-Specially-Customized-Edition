# ============================================================
# poc/resolve36-version-test.ps1
# Phase 3.6 test suite:
#   Part A - offline pure tests (no network): version semantics, context vs version
#            markers, tie handling, studio-vs-live policy, album precedence
#   Part B - real-song version matrix (phase36-matrix.json, 20 songs) asserting
#            POLICY invariants: a canonical request never auto-accepts a non-canonical
#            recording, an explicit album always wins, an explicit version request is
#            honoured or safely refused.
# No playback is involved.  ASCII-only file; all song text lives in UTF-8 JSON.
# ============================================================
[CmdletBinding()]
param([int]$SleepMs = 600, [string]$Only = '', [switch]$OfflineOnly)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot '..\phase3-resolve\lib\resolve35.ps1')

$findings = Join-Path $PSScriptRoot '..\findings\phase3'
if (-not (Test-Path $findings)) { New-Item -ItemType Directory -Force -Path $findings | Out-Null }
$stamp = Get-AmStamp
$jsonl = Join-Path $findings ('version36-' + $stamp + '.jsonl')
$md = Join-Path $findings ('version36-' + $stamp + '.md')
$results = New-Object System.Collections.Generic.List[object]
$script:P = 0; $script:F = 0

function Rec($id, $group, $desc, $pass, $detail) {
  $results.Add([ordered]@{ id = $id; group = $group; desc = $desc; pass = [bool]$pass; detail = $detail })
  if ($pass) { $script:P++ } else { $script:F++ }
  $tag = 'PASS'; if (-not $pass) { $tag = 'FAIL' }
  Write-Host ($tag + ' [' + $id + '] ' + $desc + ' :: ' + $detail)
}

$FX = (Get-Content -Path (Join-Path $PSScriptRoot '..\phase3-resolve\phase36-pure.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
$gn = $FX.guangnian; $ten = $FX.ten; $bh = $FX.bohemian; $albs = $FX.albums; $ttls = $FX.titles

Write-Host '== Part A: offline pure tests =='
$studio = New-AmCandidate -TrackId 'A1' -Title $gn.title -Artist $gn.artist -Album $gn.albumSingle -Storefront 'cn' -RequestTitle $gn.title -RequestArtist $gn.artist
$live = New-AmCandidate -TrackId 'B1' -Title $gn.titleLiveParen -Artist $gn.artist -Album $gn.albumLive -Storefront 'cn' -RequestTitle $gn.title -RequestArtist $gn.artist

$s = Select-AmBestCandidate -Candidates @($studio, $live) -RequestTitle $gn.title -RequestAlbum '' -Storefront 'cn'
Rec 'A01' 'pure' 'studio beats live when no album is given' (($s.winner.trackId -eq 'A1') -and (-not $s.ambiguous)) ('winner=' + $s.winner.trackId + ' canonical=' + $s.winner.versionCanonical + ' ambiguous=' + $s.ambiguous)

$c1 = New-AmCandidate -TrackId 'C1' -Title $ten.title -Artist $ten.artist -Album $ten.albumA -Storefront 'cn' -RequestTitle $ten.title -RequestArtist $ten.artist
$c2 = New-AmCandidate -TrackId 'C2' -Title $ten.title -Artist $ten.artist -Album $ten.albumB -Storefront 'cn' -RequestTitle $ten.title -RequestArtist $ten.artist
$s = Select-AmBestCandidate -Candidates @($c1, $c2) -RequestTitle $ten.title -RequestAlbum '' -Storefront 'cn'
Rec 'A02' 'pure' 'equal score on different recordings -> AMBIGUOUS' ($s.ambiguous -and $s.reason -eq 'RESOLVE_AMBIGUOUS') ('reason=' + $s.reason + ' distinct=' + $s.distinctRecordings + ' scores=' + $c1.scoreWithEvidence + '/' + $c2.scoreWithEvidence)

# a candidate must always be scored against the ACTUAL request context
$c1r = New-AmCandidate -TrackId 'C1' -Title $ten.title -Artist $ten.artist -Album $ten.albumA -Storefront 'cn' -RequestTitle $ten.title -RequestArtist $ten.artist -RequestAlbum $ten.albumA
$c2r = New-AmCandidate -TrackId 'C2' -Title $ten.title -Artist $ten.artist -Album $ten.albumB -Storefront 'cn' -RequestTitle $ten.title -RequestArtist $ten.artist -RequestAlbum $ten.albumA
$s = Select-AmBestCandidate -Candidates @($c1r, $c2r) -RequestTitle $ten.title -RequestAlbum $ten.albumA -Storefront 'cn'
Rec 'A03' 'pure' 'equal score but one album exact -> that one wins, no ambiguity' (($s.winner.trackId -eq 'C1') -and (-not $s.ambiguous)) ('winner=' + $s.winner.trackId + ' ambiguous=' + $s.ambiguous + ' albumExact=' + $c1r.albumExact + '/' + $c2r.albumExact)

$bohem = New-AmCandidate -TrackId 'D1' -Title $bh.title -Artist $bh.artist -Album $bh.albumStudio -Storefront 'cn' -RequestTitle $bh.title -RequestArtist $bh.artist -RequestAlbum $bh.albumLive
$bohemLive = New-AmCandidate -TrackId 'D2' -Title $bh.titleLive -Artist $bh.artist -Album $bh.albumLive -Storefront 'cn' -RequestTitle $bh.title -RequestArtist $bh.artist -RequestAlbum $bh.albumLive
$s = Select-AmBestCandidate -Candidates @($bohem, $bohemLive) -RequestTitle $bh.title -RequestAlbum $bh.albumLive -Storefront 'cn'
Rec 'A04' 'pure' 'explicit live-album request beats the version heuristic' ($s.winner.trackId -eq 'D2') ('winner=' + $s.winner.trackId + ' versionLayer=' + $s.winner.versionLayer)

$studioForLive = New-AmCandidate -TrackId 'A1' -Title $gn.title -Artist $gn.artist -Album $gn.albumSingle -Storefront 'cn' -RequestTitle $gn.titleLiveParen -RequestArtist $gn.artist
$liveForLive = New-AmCandidate -TrackId 'B1' -Title $gn.titleLiveParen -Artist $gn.artist -Album $gn.albumLive -Storefront 'cn' -RequestTitle $gn.titleLiveParen -RequestArtist $gn.artist
$s = Select-AmBestCandidate -Candidates @($studioForLive, $liveForLive) -RequestTitle $gn.titleLiveParen -RequestAlbum '' -Storefront 'cn'
Rec 'A05' 'pure' 'explicit (Live) title request selects the live candidate' ($s.winner.trackId -eq 'B1') ('winner=' + $s.winner.trackId + ' layer=' + $s.winner.versionLayer)

$s = Select-AmBestCandidate -Candidates @($live) -RequestTitle $gn.title -RequestAlbum '' -Storefront 'cn'
Rec 'A06' 'pure' 'a lone live candidate is accepted but flagged non-canonical' (($s.winner.trackId -eq 'B1') -and (-not $s.winner.versionCanonical) -and (-not $s.choseCanonical) -and ($s.notes.Count -gt 0)) ('notes=' + ($s.notes -join '; '))

$e1 = New-AmCandidate -TrackId 'E1' -Title $ten.title -Artist $ten.artist -Album $ten.albumA -Storefront 'hk' -RequestTitle $ten.title -RequestArtist $ten.artist
$e2 = New-AmCandidate -TrackId 'E2' -Title $ten.title -Artist $ten.artist -Album $ten.albumA -Storefront 'cn' -RequestTitle $ten.title -RequestArtist $ten.artist
$s = Select-AmBestCandidate -Candidates @($e1, $e2) -RequestTitle $ten.title -RequestAlbum '' -Storefront 'cn'
Rec 'A07' 'pure' 'same recording behind two ids -> deterministic storefront pick, not ambiguous' (($s.winner.trackId -eq 'E2') -and (-not $s.ambiguous)) ('winner=' + $s.winner.trackId + ' ambiguous=' + $s.ambiguous)

$v = Get-AmVersionLayer $gn.titleFilmHk $gn.albumFilmHk $gn.title ''
Rec 'A08' 'pure' 'film-theme annotation is CONTEXT, not a version marker' ($v.canonical -and $v.layer -eq 'canonical') ('layer=' + $v.layer + ' classes=' + ($v.classes -join ','))
$v = Get-AmVersionLayer $gn.title $gn.albumShow $gn.title ''
Rec 'A09' 'pure' 'variety-show episode album is a weak non-canonical signal' ((-not $v.canonical) -and ($v.layer -eq 'noncanonical-weak') -and ($v.classes -contains 'show')) ('layer=' + $v.layer + ' classes=' + ($v.classes -join ','))
$v = Get-AmVersionLayer $gn.titleLiveParen $gn.albumShow $gn.title ''
Rec 'A10' 'pure' 'explicit (Live) marker outranks the weak album signal' ((-not $v.canonical) -and ($v.layer -eq 'noncanonical-explicit') -and ($v.classes -contains 'live')) ('layer=' + $v.layer + ' classes=' + ($v.classes -join ','))

$markers = @(
  @{ t = 'Song (Live)'; c = 'live' }, @{ t = 'Song (Acoustic)'; c = 'acoustic' }, @{ t = 'Song (Remix)'; c = 'remix' },
  @{ t = 'Song (Remastered)'; c = 'remaster' }, @{ t = 'Song (Re-recorded)'; c = 'rerecorded' }, @{ t = 'Song (Instrumental)'; c = 'instrumental' },
  @{ t = 'Song (Karaoke)'; c = 'karaoke' }, @{ t = 'Song (Demo)'; c = 'demo' }, @{ t = 'Song (Radio Edit)'; c = 'radio' },
  @{ t = 'Song (Extended)'; c = 'extended' }, @{ t = 'Song (OST)'; c = 'ost' }, @{ t = 'Song (Original Soundtrack)'; c = 'ost' }
)
$miss = @()
foreach ($m in $markers) { $v = Get-AmVersionLayer $m.t '' 'Song' ''; if (-not ($v.classes -contains $m.c)) { $miss += ($m.t + '->' + $m.c) } }
$albumForms = @(
  @{ a = $albs.compilationAscii; c = 'compilation' }, @{ a = $albs.liveCjk; c = 'live' },
  @{ a = $albs.show; c = 'show' }, @{ a = $albs.compilationCjk; c = 'compilation' }
)
foreach ($m in $albumForms) { $v = Get-AmVersionLayer 'Song' $m.a 'Song' ''; if (-not ($v.classes -contains $m.c)) { $miss += ($m.a + '->' + $m.c) } }
Rec 'A11' 'pure' 'every required version class is detected (12 title + 4 album forms)' ($miss.Count -eq 0) ('missed=[' + ($miss -join '; ') + '] checked=' + ($markers.Count + $albumForms.Count))

$fp = @('Alive', 'Living Room', 'Deliver', 'Believe', 'Deluxe Edition', 'Song (Deluxe)', 'Song (feat. Someone)', 'Song (From the movie X)', $ttls.ordinaryCjk, $ttls.filmThemeAsciiCjk)
$bad = @()
foreach ($t in $fp) { $v = Get-AmVersionLayer $t '' 'Song' ''; if (-not $v.canonical) { $bad += ($t + '->' + ($v.classes -join ',')) } }
$pos = Get-AmVersionLayer 'Song (Live in Tokyo)' '' 'Song' ''
if (-not ($pos.classes -contains 'live')) { $bad += 'Song (Live in Tokyo)->missed' }
Rec 'A12' 'pure' 'no false positives on ordinary words; real markers still detected' ($bad.Count -eq 0) ('bad=[' + ($bad -join '; ') + ']')

$al = Get-AmAlbumLayer $ttls.albumYehui $ttls.albumYehuiTraditional
Rec 'A13' 'pure' 'album traditional/simplified variant is exact-cjk' (($al.layer -eq 'exact-cjk') -and $al.exact) ('layer=' + $al.layer)
$tl = Get-AmTitleLayer36 $gn.title $gn.titleFilmCn
Rec 'A14' 'pure' 'title with a context annotation compares as exact-context' (($tl.layer -eq 'exact-context') -and ($tl.score -eq 8)) ('layer=' + $tl.layer + ' score=' + $tl.score)
$tl = Get-AmTitleLayer36 $gn.title $gn.titleLiveParen
Rec 'A15' 'pure' 'a live title is never collapsed into the plain title' ($tl.layer -ne 'exact-context') ('layer=' + $tl.layer + ' score=' + $tl.score)

if (-not $OfflineOnly) {
  Write-Host ''
  Write-Host '== Part B: real-song version matrix =='
  $cases = @((Get-Content -Path (Join-Path $PSScriptRoot '..\phase3-resolve\phase36-matrix.json') -Raw -Encoding UTF8 | ConvertFrom-Json).cases)
  if ($Only -ne '') { $want = $Only.Split(','); $cases = @($cases | Where-Object { $want -contains $_.id }) }
  $wrongArtist = 0; $wrongVersionAuto = 0; $canonicalOk = 0; $refusals = 0; $autoPlays = 0
  foreach ($c in $cases) {
    $rargs = @{ Title = ('' + $c.title); Artist = ('' + $c.artist); Storefront = 'cn' }
    if (('' + $c.album) -ne '') { $rargs['Album'] = ('' + $c.album) }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Resolve-AmSong @rargs
    $ms = [int]$sw.ElapsedMilliseconds
    $resolved = [bool]$r.ok
    $canonical = [bool]$r.version.canonical
    $auto = [bool]$r.autoPlayable
    $albumLayer = '' + $r.matched.albumLayer
    $verdict = ''; $fail = $false
    switch (('' + $c.expect)) {
      'prefer-canonical' {
        if (-not $resolved) { $verdict = 'SAFE-REFUSAL:' + $r.reason; $refusals++ }
        elseif ($canonical) { $verdict = 'CANONICAL'; $canonicalOk++ }
        elseif ($auto) { $verdict = 'FAIL-NONCANONICAL-AUTOPLAY'; $fail = $true }
        else { $verdict = 'NONCANONICAL-NOT-AUTOPLAYABLE'; $refusals++ }
      }
      'album-locked' {
        if (-not $resolved) { $verdict = 'SAFE-REFUSAL:' + $r.reason; $refusals++ }
        elseif ($albumLayer -in @('exact', 'exact-cjk')) { $verdict = 'ALBUM-EXACT'; $canonicalOk++ }
        elseif ($auto) { $verdict = 'FAIL-WRONG-ALBUM-AUTOPLAY'; $fail = $true }
        else { $verdict = 'ALBUM-NOT-EXACT-NOT-AUTOPLAYABLE'; $refusals++ }
      }
      'requested-version' {
        if (-not $resolved) { $verdict = 'SAFE-REFUSAL:' + $r.reason; $refusals++ }
        elseif (('' + $r.version.layer) -eq 'requested-version') { $verdict = 'REQUESTED-VERSION'; $canonicalOk++ }
        elseif ($auto) { $verdict = 'FAIL-IGNORED-VERSION-REQUEST'; $fail = $true }
        else { $verdict = 'VERSION-NOT-MATCHED-NOT-AUTOPLAYABLE'; $refusals++ }
      }
      default {
        if (-not $resolved) { $verdict = 'REFUSED:' + $r.reason; $refusals++ } else { $verdict = 'RESOLVED'; $canonicalOk++ }
      }
    }
    $checkArtist = '' + $r.lookup.artist
    if ($checkArtist -eq '') { $checkArtist = '' + $r.matched.artist }
    $alayerScore = -1
    if ($resolved -and ('' + $c.artist) -ne '' -and $checkArtist -ne '') { $alayerScore = [int](Test-AmArtistLayer ('' + $c.artist) $checkArtist).score }
    if ($resolved -and $alayerScore -eq 0) { $wrongArtist++; $fail = $true; $verdict += '+FAIL-WRONG-ARTIST' }
    if ($auto -and -not (('' + $r.version.layer) -in @('canonical', 'requested-version'))) { $wrongVersionAuto++; $fail = $true; $verdict += '+FAIL-WRONG-VERSION-AUTOPLAY' }
    if ($auto) { $autoPlays++ }
    $row = [ordered]@{
      id = $c.id; tag = $c.tag; expect = $c.expect; title = $c.title; artist = $c.artist; album = $c.album
      verdict = $verdict; pass = (-not $fail); reason = $r.reason; confidence = $r.confidence; autoPlayable = $auto
      songId = $r.songId; storefront = $r.storefront; canonicalUrl = $r.canonicalUrl
      matchedTitle = $r.matched.title; matchedArtist = $r.matched.artist; matchedAlbum = $r.matched.album
      versionLayer = $r.version.layer; versionClasses = ($r.version.classes -join ','); versionCanonical = $canonical
      albumLayer = $albumLayer; artistLayerScore = $alayerScore; score = $r.score
      runnerUpId = $r.runnerUp.songId; runnerUpTitle = $r.runnerUp.title; runnerUpAlbum = $r.runnerUp.album; runnerUpScore = $r.runnerUp.score
      poolSize = $r.candidateCount; totalCandidates = $r.totalCandidates; ambiguous = $r.ambiguous; tie = $r.tie
      distinctRecordings = $r.distinctRecordings; choseCanonical = $r.choseCanonical; selectionNotes = ($r.selectionNotes -join '; ')
      ms = $ms; ts = (Get-AmIsoNow)
    }
    Add-AmJsonLine $jsonl $row
    Rec $c.id ('real/' + $c.tag) ('' + $c.title + ' / ' + $c.artist + ' / ' + $c.album + ' [' + $c.expect + ']') (-not $fail) ($verdict + ' conf=' + $r.confidence + ' id=' + $r.songId + ' album=' + $r.matched.album + ' ver=' + $r.version.layer + '(' + ($r.version.classes -join ',') + ') sf=' + $r.storefront + ' ' + $ms + 'ms')
    Start-Sleep -Milliseconds $SleepMs
  }
  Write-Host ''
  Write-Host ('REAL MATRIX: cases=' + $cases.Count + ' canonical-ok=' + $canonicalOk + ' safe-refusals=' + $refusals + ' autoPlayable=' + $autoPlays)
  Write-Host ('WRONG_ARTIST_ACCEPTANCES=' + $wrongArtist)
  Write-Host ('WRONG_VERSION_AUTOMATIC_ACCEPTANCE=' + $wrongVersionAuto)
}

Write-Host ''
Write-Host ('TOTAL PASS=' + $script:P + ' FAIL=' + $script:F)
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# Phase 3.6 version-semantics test suite ' + $stamp)
$lines.Add('')
$lines.Add('| id | group | test | result | detail |')
$lines.Add('|---|---|---|---|---|')
foreach ($r in $results) {
  $t = 'PASS'; if (-not $r.pass) { $t = '**FAIL**' }
  $lines.Add('| ' + $r.id + ' | ' + $r.group + ' | ' + $r.desc + ' | ' + $t + ' | ' + ($r.detail -replace '\|', '/') + ' |')
}
$lines.Add('')
$lines.Add('TOTAL PASS=' + $script:P + ' FAIL=' + $script:F)
Write-AmText $md ($lines -join "`r`n")
Write-Host ('report: ' + $md)
if ($script:F -gt 0) { exit 1 }
