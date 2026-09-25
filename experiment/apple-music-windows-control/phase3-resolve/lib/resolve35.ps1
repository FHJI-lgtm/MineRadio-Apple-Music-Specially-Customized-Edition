# ============================================================
# phase3-resolve/lib/resolve35.ps1   (Phase 3.6: version semantics + precision)
# (title, artist[, album]) -> correct Apple Music Song ID + canonical URL, WITHOUT
# a hardcoded URL and WITHOUT ever returning a knowingly wrong song/version.
#
# Layered, evidence-based decisions (no unbounded fuzzy matching):
#   title   : exact > exact-context > prefix > contains   (title is mandatory)
#   artist  : exact > normalized > catalog alias > CJK credit variant (never contains)
#   album   : normalized exact > exact-CJK > contains     (exact beats contained)
#   version : canonical (studio) > requested-version match > weak context > other
#             (see version36.ps1; explicit title markers vs context annotations)
#   evidence: the authoritative lookup(id, country) metadata is re-scored and, when a
#             real candidate exists, outranks the search-time score.  A lookup that
#             contradicts the request refuses the result (WRONG_ARTIST/ALBUM/VERSION).
#
# Selection is done by the pure comparator Select-AmBestCandidate (version36.ps1):
# equal evidence across different recordings is AMBIGUOUS - never array order.
#
# Discovery strategies (general, no per-song patches):
#   S1 title+artist+album   S2 title+artist   S3 title   S4 title+album
#   S5 attribute=artistTerm (finds an artist's songs when a plain CJK query is empty)
#   S6 album search -> lookup(collectionId, entity=song) -> match the track by title
#
# Storefront ladder cn -> tw -> hk -> us -> default; the chosen id is verified with a
# real lookup(id, country) before it is returned.
#
# Reuses the frozen helpers from poc/lib/am-common.ps1 read-only.
# ASCII-only on purpose (all non-ASCII data lives in JSON).
# ============================================================

$script:P3Root = $PSScriptRoot | Split-Path -Parent
$script:P3ExpRoot = $script:P3Root | Split-Path -Parent
. (Join-Path $script:P3ExpRoot 'poc\lib\am-common.ps1')
. (Join-Path $script:P3Root 'lib\version36.ps1')

$script:AmStorefrontLadder = @('cn', 'tw', 'hk', 'us', '')

# Validated catalog credit aliases - only pairs observed in real storefront data.
# Anything not listed must match through the normal layers, so two unrelated artists
# can never be merged (The Weeknd vs Fame on Fire stays a mismatch).
$script:AmArtistAliases = @(
  @{ a = 'the weeknd'; b = 'abel tesfaye' }
)

function Get-AmArtistKey([string]$name) { return ((Normalize-AmText $name) -replace ' ', '') }

function Test-AmArtistLayer([string]$want, [string]$got) {
  $res = @{ ok = $false; layer = 'none'; score = 0 }
  if ([string]::IsNullOrEmpty($want)) { $res.ok = $true; $res.layer = 'not-requested'; $res.score = 8; return $res }
  if ([string]::IsNullOrEmpty($got)) { return $res }
  if ($want.Trim().ToLowerInvariant() -eq $got.Trim().ToLowerInvariant()) { $res.ok = $true; $res.layer = 'exact'; $res.score = 10; return $res }
  $w = Normalize-AmText $want; $g = Normalize-AmText $got
  if ($w -and $g -and ($w -eq $g)) { $res.ok = $true; $res.layer = 'normalized'; $res.score = 9; return $res }
  $wk = Get-AmArtistKey $want; $gk = Get-AmArtistKey $got
  foreach ($al in $script:AmArtistAliases) {
    # the alias table is written with spaces ("the weeknd"); the keys above are
    # space-stripped, so BOTH sides must be key-normalized before comparing -
    # otherwise the catalog credit "Abel Tesfaye" is treated as a different artist.
    $ka = Get-AmArtistKey $al.a; $kb = Get-AmArtistKey $al.b
    if (($wk -eq $ka -and $gk -eq $kb) -or ($wk -eq $kb -and $gk -eq $ka)) { $res.ok = $true; $res.layer = 'alias'; $res.score = 8; return $res }
  }
  if ((Test-AmHasCjk $want) -or (Test-AmHasCjk $got)) {
    if ($wk -and $gk) {
      $hits = 0
      foreach ($ch in $wk.ToCharArray()) { if ($gk.Contains([string]$ch)) { $hits++ } }
      if (($hits / $wk.Length) -ge 0.6) { $res.ok = $true; $res.layer = 'cjk'; $res.score = 7; return $res }
    }
  }
  return $res
}

function Get-AmTitleLayer([string]$want, [string]$got) {
  $res = @{ ok = $false; layer = 'none'; score = 0 }
  if (-not $want -or -not $got) { return $res }
  $w = Normalize-AmText $want; $g = Normalize-AmText $got
  if (-not $w -or -not $g) { return $res }
  if ($w -eq $g) { $res.ok = $true; $res.layer = 'exact'; $res.score = 8; return $res }
  if ($g.StartsWith($w)) { $res.ok = $true; $res.layer = 'prefix'; $res.score = 5; return $res }
  if ($g.Contains($w)) { $res.ok = $true; $res.layer = 'contains'; $res.score = 3; return $res }
  return $res
}

function Get-AmAlbumLayer([string]$want, [string]$got) {
  $res = @{ ok = $false; layer = 'none'; score = 0; exact = $false }
  if ([string]::IsNullOrEmpty($want)) { $res.ok = $true; $res.layer = 'not-requested'; return $res }
  if ([string]::IsNullOrEmpty($got)) { return $res }
  $w = Normalize-AmText $want; $g = Normalize-AmText $got
  if (-not $w -or -not $g) { return $res }
  if ($w -eq $g) { $res.ok = $true; $res.layer = 'exact'; $res.score = 6; $res.exact = $true; return $res }
  if ((Test-AmHasCjk $want) -or (Test-AmHasCjk $got)) {
    $wk = $w -replace ' ', ''; $gk = $g -replace ' ', ''
    if ($wk -and $gk) {
      $hits = 0
      foreach ($ch in $wk.ToCharArray()) { if ($gk.Contains([string]$ch)) { $hits++ } }
      if (($hits / $wk.Length) -ge 0.6) { $res.ok = $true; $res.layer = 'exact-cjk'; $res.score = 5; $res.exact = $true; return $res }
    }
  }
  if ($g.Contains($w) -or $w.Contains($g)) { $res.ok = $true; $res.layer = 'contains'; $res.score = 2; return $res }
  return $res
}

function ConvertTo-AmSongSlug([string]$Title) {
  if ([string]::IsNullOrEmpty($Title)) { return 'song' }
  $s = $Title.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $s = $s.Trim('-')
  if (-not $s) { return 'song' }   # CJK-only title: the song id is the key, not the slug
  if ($s.Length -gt 60) { $s = $s.Substring(0, 60).Trim('-') }
  return $s
}

function Get-AmCanonicalSongUrl([string]$SongId, [string]$Storefront = 'cn', [string]$Title = '') {
  if (-not $Storefront) { $Storefront = 'cn' }
  return ('https://music.apple.com/' + $Storefront + '/song/' + (ConvertTo-AmSongSlug $Title) + '/' + $SongId)
}

function Get-AmItunesHttp([string]$Uri, [int]$Retries = 3) {
  for ($i = 1; $i -le $Retries; $i++) {
    try {
      $raw = (Invoke-WebRequest -Uri $Uri -TimeoutSec 25 -UseBasicParsing -Headers @{ 'User-Agent' = 'mineradio-phase36' }).Content
      return @{ ok = $true; json = ($raw | ConvertFrom-Json); uri = $Uri; error = '' }
    } catch {
      if ($i -eq $Retries) { return @{ ok = $false; json = $null; uri = $Uri; error = $_.Exception.Message } }
      Start-Sleep -Milliseconds 400
    }
  }
}

function Invoke-AmItunesSearch2 {
  param([string]$Term, [string]$Entity = 'song', [int]$Limit = 25, [string]$Storefront = '', [string]$Attribute = '')
  $uri = 'https://itunes.apple.com/search?term=' + [uri]::EscapeDataString($Term) + '&entity=' + $Entity + '&limit=' + $Limit
  if ($Attribute) { $uri += '&attribute=' + $Attribute }
  if ($Storefront) { $uri += '&country=' + $Storefront }
  $r = Get-AmItunesHttp $uri
  $items = @()
  if ($r.ok -and $r.json -and $r.json.results) { $items = @($r.json.results) }
  return @{ ok = $r.ok; results = $items; uri = $uri; error = $r.error; count = $items.Count }
}

function Invoke-AmItunesLookup2 {
  param([string]$Id, [string]$Storefront = '', [string]$Entity = 'song')
  $uri = 'https://itunes.apple.com/lookup?id=' + [uri]::EscapeDataString($Id) + '&entity=' + $Entity
  if ($Storefront) { $uri += '&country=' + $Storefront }
  $r = Get-AmItunesHttp $uri
  $items = @()
  if ($r.ok -and $r.json -and $r.json.results) { $items = @($r.json.results) }
  return @{ ok = $r.ok; results = $items; uri = $uri; error = $r.error; count = $items.Count }
}

function Test-AmSongIdAlive {
  param([string]$SongId, [string]$PreferredStorefront = 'cn')
  $tried = @()
  foreach ($sf in @($PreferredStorefront) + $script:AmStorefrontLadder) {
    if ($tried -contains $sf) { continue }
    $tried += $sf
    $r = Invoke-AmItunesLookup2 -Id $SongId -Storefront $sf -Entity 'song'
    if ($r.ok -and $r.count -gt 0) {
      $t = $r.results[0]
      return @{ ok = $true; storefront = $sf; trackId = ('' + $t.trackId); title = ('' + $t.trackName); artist = ('' + $t.artistName); album = ('' + $t.collectionName); trackViewUrl = ('' + $t.trackViewUrl); inRequested = ($sf -eq $PreferredStorefront) }
    }
  }
  return @{ ok = $false; storefront = ''; trackId = ''; title = ''; artist = ''; album = ''; trackViewUrl = ''; inRequested = $false }
}

function Resolve-AmSong {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Artist = '',
    [string]$Album = '',
    [string]$Storefront = 'cn',
    [int]$Limit = 25,
    [switch]$NoLookup
  )
  $evidence = New-Object System.Collections.Generic.List[object]
  $cands = @()
  $ladder = @()
  foreach ($sf in @($Storefront) + $script:AmStorefrontLadder) { if ($ladder -notcontains $sf) { $ladder += $sf } }

  $strategies = @()
  if ($Artist -and $Album) { $strategies += @{ name = 'S1-title+artist+album'; term = ($Title + ' ' + $Artist + ' ' + $Album); attribute = '' } }
  if ($Artist) { $strategies += @{ name = 'S2-title+artist'; term = ($Title + ' ' + $Artist); attribute = '' } }
  $strategies += @{ name = 'S3-title'; term = $Title; attribute = '' }
  if ($Album) { $strategies += @{ name = 'S4-title+album'; term = ($Title + ' ' + $Album); attribute = '' } }
  if ($Artist) { $strategies += @{ name = 'S5-artistTerm'; term = $Artist; attribute = 'artistTerm' } }

  $stop = $false
  foreach ($st in $strategies) {
    foreach ($sf in $ladder) {
      $r = Invoke-AmItunesSearch2 -Term $st.term -Entity 'song' -Limit $Limit -Storefront $sf -Attribute $st.attribute
      $ev = [ordered]@{ strategy = $st.name; storefront = $sf; term = $st.term; attribute = $st.attribute; ok = $r.ok; count = $r.count; uri = $r.uri; error = $r.error; candidates = 0 }
      $found = 0
      if ($r.ok) {
        foreach ($it in $r.results) {
          if (('' + $it.kind) -ne 'song') { continue }
          $t = Get-AmTitleLayer36 $Title ('' + $it.trackName)
          if (-not $t.ok) { continue }                                  # title is mandatory
          $found++
          $cands += , (New-AmCandidate -TrackId ('' + $it.trackId) -CollectionId ('' + $it.collectionId) `
              -Title ('' + $it.trackName) -Artist ('' + $it.artistName) -Album ('' + $it.collectionName) `
              -Storefront $sf -Strategy $st.name -TrackNumber ([int]('0' + ('' + $it.trackNumber))) `
              -RequestTitle $Title -RequestArtist $Artist -RequestAlbum $Album)
        }
      }
      $ev['candidates'] = $found
      $evidence.Add([pscustomobject]$ev)
      # Early exit: a canonical, fully matching candidate is enough; keep the API bounded.
      $good = @($cands | Where-Object {
          $_.titleLayer -in @('exact', 'exact-context') -and $_.artistLayer -in @('exact', 'normalized') -and
          $_.versionCanonical -and ($_.albumExact -or -not $Album)
        })
      if ($good.Count -gt 0) { $stop = $true; break }
    }
    if ($stop) { break }
  }

  # S6: album search -> album lookup -> match the track by title
  if ($Album -and $Artist) {
    foreach ($sf in $ladder) {
      $as = Invoke-AmItunesSearch2 -Term ($Album + ' ' + $Artist) -Entity 'album' -Limit 10 -Storefront $sf
      $ev = [ordered]@{ strategy = 'S6-album->lookup'; storefront = $sf; term = ($Album + ' ' + $Artist); attribute = ''; ok = $as.ok; count = $as.count; uri = $as.uri; error = $as.error; candidates = 0 }
      $added = 0
      if ($as.ok) {
        foreach ($alb in $as.results) {
          $alLayer = Get-AmAlbumLayer $Album ('' + $alb.collectionName)
          if (-not $alLayer.ok) { continue }
          $cid = '' + $alb.collectionId
          if (-not $cid) { continue }
          $lk = Invoke-AmItunesLookup2 -Id $cid -Storefront $sf -Entity 'song'
          if (-not ($lk.ok -and $lk.count -gt 0)) { continue }
          foreach ($it in $lk.results) {
            if (('' + $it.kind) -ne 'song') { continue }
            $t = Get-AmTitleLayer36 $Title ('' + $it.trackName)
            if (-not $t.ok) { continue }
            $added++
            $cands += , (New-AmCandidate -TrackId ('' + $it.trackId) -CollectionId ('' + $it.collectionId) `
                -Title ('' + $it.trackName) -Artist ('' + $it.artistName) -Album ('' + $it.collectionName) `
                -Storefront $sf -Strategy 'S6-album->lookup' -TrackNumber ([int]('0' + ('' + $it.trackNumber))) `
                -RequestTitle $Title -RequestArtist $Artist -RequestAlbum $Album)
          }
        }
      }
      $ev['candidates'] = $added
      $evidence.Add([pscustomobject]$ev)
    }
  }

  $byId = @{}
  foreach ($c in $cands) {
    if (-not $c.trackId) { continue }
    if ((-not $byId.ContainsKey($c.trackId)) -or ($c.scoreWithEvidence -gt $byId[$c.trackId].scoreWithEvidence)) { $byId[$c.trackId] = $c }
  }
  $all = @($byId.Values)

  $out = @{
    ok = $false; reason = 'RESOLVE_NOT_FOUND'; confidence = 'NOT_FOUND'
    songId = ''; storefront = ''; canonicalUrl = ''; slug = ''; score = 0
    matched = @{ title = ''; artist = ''; album = ''; trackId = '' }
    runnerUp = @{ songId = ''; title = ''; artist = ''; album = ''; score = 0 }
    lookup = @{ performed = $false; ok = $false; storefront = ''; inRequested = $false; title = ''; artist = ''; album = '' }
    version = @{ classes = @(); canonical = $false; layer = ''; reason = ''; requestClasses = @((Get-AmVersionRequest $Title $Album).classes) }
    evidence = $evidence; candidateCount = 0; totalCandidates = 0
    ambiguous = $false; tie = $false; distinctRecordings = 0; choseCanonical = $false; selectionNotes = @()
    autoPlayable = $false; ts = (Get-AmIsoNow)
  }
  $out.totalCandidates = $all.Count
  if ($all.Count -eq 0) { return $out }

  $sel = Select-AmBestCandidate -Candidates $all -RequestAlbum $Album -RequestTitle $Title -Storefront $Storefront -Ladder $ladder
  $out.ambiguous = $sel.ambiguous
  $out.tie = $sel.tie
  $out.distinctRecordings = $sel.distinctRecordings
  $out.choseCanonical = $sel.choseCanonical
  $out.selectionNotes = @($sel.notes)
  $out.candidateCount = $sel.poolSize
  $top = $sel.winner
  if ($top -eq $null) { return $out }
  $second = $sel.runnerUp
  $out.score = $top.scoreWithEvidence
  $out.matched = @{ title = $top.title; artist = $top.artist; album = $top.album; trackId = $top.trackId
                    titleLayer = $top.titleLayer; artistLayer = $top.artistLayer; albumLayer = $top.albumLayer
                    albumExact = $top.albumExact; versionLayer = $top.versionLayer }
  if ($second) { $out.runnerUp = @{ songId = $second.trackId; title = $second.title; artist = $second.artist; album = $second.album; score = $second.scoreWithEvidence; versionLayer = $second.versionLayer } }
  $out.version = @{ classes = @($top.versionClasses); canonical = $top.versionCanonical; layer = $top.versionLayer
                    reason = $top.versionReason; policy = ($sel.notes -join '; '); requestClasses = @((Get-AmVersionRequest $Title $Album).classes) }

  if ($sel.ambiguous) {
    $out.reason = 'RESOLVE_AMBIGUOUS'
    $out.confidence = 'AMBIGUOUS'
    return $out
  }

  # ---- accepted winner: let the authoritative catalog lookup decide ----
  $lookupOk = $false
  $lvTitle = ''; $lvArtist = ''; $lvAlbum = ''
  if (-not $NoLookup) {
    $lv = Test-AmSongIdAlive -SongId $top.trackId -PreferredStorefront $Storefront
    $lookupOk = $lv.ok
    $lvTitle = $lv.title; $lvArtist = $lv.artist; $lvAlbum = $lv.album
    $out.lookup = @{ performed = $true; ok = $lv.ok; storefront = $lv.storefront; inRequested = $lv.inRequested; title = $lv.title; artist = $lv.artist; album = $lv.album }
    if ($lv.ok) {
      $win2 = New-AmCandidate -TrackId $top.trackId -CollectionId $top.collectionId -Title $top.title -Artist $top.artist `
        -Album $top.album -Storefront $top.storefront -Strategy $top.strategy -TrackNumber $top.trackNumber `
        -RequestTitle $Title -RequestArtist $Artist -RequestAlbum $Album `
        -LookupConfirmed $true -LookupTitle $lv.title -LookupArtist $lv.artist -LookupAlbum $lv.album
      $out.score = $win2.scoreWithEvidence
      $out.matched = @{ title = $lv.title; artist = $lv.artist; album = $lv.album; trackId = $top.trackId
                        titleLayer = $win2.titleLayer; artistLayer = $win2.artistLayer; albumLayer = $win2.albumLayer
                        albumExact = $win2.albumExact; versionLayer = $win2.versionLayer }
      $out.version = @{ classes = @($win2.versionClasses); canonical = $win2.versionCanonical; layer = $win2.versionLayer
                        reason = $win2.versionReason; policy = ($sel.notes -join '; '); requestClasses = @($out.version.requestClasses) }
      # deterministic guard: catalog truth must never contradict the request
      $tl = Get-AmTitleLayer36 $Title $lv.title
      $at = Test-AmArtistLayer $Artist $lv.artist
      $al = Get-AmAlbumLayer $Album $lv.album
      $vg = Get-AmVersionLayer $lv.title $lv.album $Title $Album
      if (-not $tl.ok) { $out.reason = 'RESOLVE_NOT_FOUND'; $out.confidence = 'LOW'; return $out }
      if ($Artist -and -not $at.ok) { $out.reason = 'RESOLVE_WRONG_ARTIST'; $out.confidence = 'LOW'; return $out }
      if ($Album -and ($al.layer -eq 'none')) { $out.reason = 'RESOLVE_WRONG_ALBUM'; $out.confidence = 'LOW'; return $out }
      if (-not $vg.ok) { $out.reason = 'RESOLVE_WRONG_VERSION'; $out.confidence = 'LOW'; return $out }
      $top = $win2
    }
  }

  $out.ok = $true
  $out.reason = 'OK'
  $out.songId = $top.trackId
  $out.storefront = $top.storefront
  # an Apple Music song id is storefront-scoped: build the deep link for the
  # storefront where the lookup actually confirmed the id, not for the requested
  # one (a cn URL for a tw-only id simply fails to navigate)
  $urlStorefront = $Storefront
  if ($out.lookup.performed -and $out.lookup.ok -and (('' + $out.lookup.storefront) -ne '')) { $urlStorefront = '' + $out.lookup.storefront }
  $out.urlStorefront = $urlStorefront
  $out.slug = ConvertTo-AmSongSlug $top.title
  $out.canonicalUrl = Get-AmCanonicalSongUrl $top.trackId $urlStorefront $top.title
  $out.confidence = Get-AmConfidence -Winner $top -Selection $sel -RequestTitle $Title -RequestArtist $Artist -RequestAlbum $Album `
    -LookupPerformed (-not $NoLookup) -LookupOk $lookupOk -LookupTitle $lvTitle -LookupArtist $lvArtist -LookupAlbum $lvAlbum
  # auto-play policy: a strong result that is also the plain version (or an explicitly
  # requested version).  A lone live/remix recording is reported but never auto-played.
  $versionOkForPlay = ($top.versionLayer -in @('canonical', 'requested-version'))
  $out.version['canonical'] = $top.versionCanonical
  $out.autoPlayable = (($out.confidence -in @('HIGH', 'MEDIUM')) -and $versionOkForPlay)
  return $out
}
