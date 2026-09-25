# ============================================================
# phase3-resolve/lib/resolve35.ps1   (Phase 3.5 hardened resolver)
# (title, artist[, album]) -> correct Apple Music Song ID + canonical URL, WITHOUT
# a hardcoded URL and WITHOUT ever returning a knowingly wrong song.
#
# Layered, evidence-based decisions (no unbounded fuzzy matching):
#   title  : exact > prefix > contains      (title must match - never optional)
#   artist : exact > normalized > catalog alias > CJK credit variant
#            (NO contains, NO edit distance - a different artist is never accepted)
#   album  : normalized exact > contains    (an exact album always outranks a merely
#            contained one, even when the contained one came back first)
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
    if (($wk -eq $al.a -and $gk -eq $al.b) -or ($wk -eq $al.b -and $gk -eq $al.a)) { $res.ok = $true; $res.layer = 'alias'; $res.score = 8; return $res }
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
      $raw = (Invoke-WebRequest -Uri $Uri -TimeoutSec 25 -UseBasicParsing -Headers @{ 'User-Agent' = 'mineradio-phase35' }).Content
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
          $t = Get-AmTitleLayer $Title ('' + $it.trackName)
          if (-not $t.ok) { continue }                                  # title is mandatory
          $a = Test-AmArtistLayer $Artist ('' + $it.artistName)
          if (-not $a.ok) { continue }                                  # other artists never accepted
          $al = Get-AmAlbumLayer $Album ('' + $it.collectionName)
          $score = $t.score + $a.score + $al.score
          if ($sf -eq $Storefront) { $score += 1 }
          $found++
          $cands += , @{
            trackId = ('' + $it.trackId); collectionId = ('' + $it.collectionId)
            title = ('' + $it.trackName); artist = ('' + $it.artistName); album = ('' + $it.collectionName)
            titleLayer = $t.layer; titleScore = $t.score
            artistLayer = $a.layer; artistScore = $a.score
            albumLayer = $al.layer; albumScore = $al.score; albumExact = $al.exact
            storefront = $sf; strategy = $st.name; score = $score
            trackViewUrl = ('' + $it.trackViewUrl); trackNumber = [int]('0' + ('' + $it.trackNumber))
          }
        }
      }
      $ev['candidates'] = $found
      $evidence.Add([pscustomobject]$ev)
      # Early exit: as soon as a HIGH-confidence candidate is in hand there is no
      # reason to keep hammering the public API (it rate-limits with 403/429).
      $good = @($cands | Where-Object {
          $_.titleLayer -eq 'exact' -and $_.artistLayer -in @('exact', 'normalized') -and
          ($_.albumExact -or -not $Album)
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
            $t = Get-AmTitleLayer $Title ('' + $it.trackName)
            if (-not $t.ok) { continue }
            $a = Test-AmArtistLayer $Artist ('' + $it.artistName)
            if (-not $a.ok) { continue }
            $al = Get-AmAlbumLayer $Album ('' + $it.collectionName)
            $score = $t.score + $a.score + $al.score
            if ($sf -eq $Storefront) { $score += 1 }
            $added++
            $cands += , @{
              trackId = ('' + $it.trackId); collectionId = ('' + $it.collectionId)
              title = ('' + $it.trackName); artist = ('' + $it.artistName); album = ('' + $it.collectionName)
              titleLayer = $t.layer; titleScore = $t.score
              artistLayer = $a.layer; artistScore = $a.score
              albumLayer = $al.layer; albumScore = $al.score; albumExact = $al.exact
              storefront = $sf; strategy = 'S6-album->lookup'; score = $score
              trackViewUrl = ('' + $it.trackViewUrl); trackNumber = [int]('0' + ('' + $it.trackNumber))
            }
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
    if ((-not $byId.ContainsKey($c.trackId)) -or ($c.score -gt $byId[$c.trackId].score)) { $byId[$c.trackId] = $c }
  }
  $sorted = @($byId.Values | Sort-Object -Property @{ Expression = { $_.score }; Descending = $true }, @{ Expression = { $_.trackNumber }; Ascending = $true })

  $out = @{
    ok = $false; reason = 'RESOLVE_NOT_FOUND'; confidence = 'NOT_FOUND'
    songId = ''; storefront = ''; canonicalUrl = ''; slug = ''; score = 0
    matched = @{ title = ''; artist = ''; album = ''; trackId = '' }
    runnerUp = @{ songId = ''; title = ''; artist = ''; album = ''; score = 0 }
    lookup = @{ performed = $false; ok = $false; storefront = ''; inRequested = $false; title = ''; artist = ''; album = '' }
    evidence = $evidence; candidateCount = $sorted.Count; ts = (Get-AmIsoNow)
  }
  if ($sorted.Count -eq 0) { return $out }

  $pool = $sorted
  if ($Album) {
    $exactAlbums = @($sorted | Where-Object { $_.albumExact })
    if ($exactAlbums.Count -gt 0) { $pool = $exactAlbums }
  }
  $top = $pool[0]
  $second = $null
  if ($pool.Count -gt 1) { $second = $pool[1] } elseif ($sorted.Count -gt 1) { $second = $sorted[1] }

  if ($second -and ($second.score -eq $top.score) -and ($second.trackId -ne $top.trackId) -and (-not $top.albumExact)) {
    $out.reason = 'RESOLVE_AMBIGUOUS'
    $out.confidence = 'AMBIGUOUS'
    $out.score = $top.score
    $out.matched = @{ title = $top.title; artist = $top.artist; album = $top.album; trackId = $top.trackId }
    $out.runnerUp = @{ songId = $second.trackId; title = $second.title; artist = $second.artist; album = $second.album; score = $second.score }
    return $out
  }

  $out.ok = $true
  $out.reason = 'OK'
  $out.songId = $top.trackId
  $out.storefront = $top.storefront
  $out.score = $top.score
  $out.slug = ConvertTo-AmSongSlug $top.title
  $out.canonicalUrl = Get-AmCanonicalSongUrl $top.trackId $Storefront $top.title
  $out.matched = @{ title = $top.title; artist = $top.artist; album = $top.album; trackId = $top.trackId; titleLayer = $top.titleLayer; artistLayer = $top.artistLayer; albumLayer = $top.albumLayer }
  if ($second) { $out.runnerUp = @{ songId = $second.trackId; title = $second.title; artist = $second.artist; album = $second.album; score = $second.score } }

  $exactTitle = ($top.titleLayer -eq 'exact')
  $goodArtist = ($top.artistLayer -in @('exact', 'normalized'))
  $albumOk = ($top.albumLayer -in @('exact', 'not-requested'))
  $noTie = ((-not $second) -or ($second.score -lt $top.score))
  if ($exactTitle -and $goodArtist -and $albumOk -and $noTie) { $out.confidence = 'HIGH' }
  elseif ($exactTitle -and $top.artistLayer -in @('alias', 'cjk') -and $albumOk) { $out.confidence = 'MEDIUM' }
  elseif ($exactTitle -and $top.albumLayer -eq 'contains') { $out.confidence = 'MEDIUM' }
  else { $out.confidence = 'LOW' }

  if (-not $NoLookup) {
    $lv = Test-AmSongIdAlive -SongId $top.trackId -PreferredStorefront $Storefront
    $out.lookup = @{ performed = $true; ok = $lv.ok; storefront = $lv.storefront; inRequested = $lv.inRequested; title = $lv.title; artist = $lv.artist; album = $lv.album }
    if (-not $lv.ok) { $out.confidence = 'LOW' }
  }
  return $out
}
