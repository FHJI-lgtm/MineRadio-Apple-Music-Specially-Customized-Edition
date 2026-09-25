# ============================================================
# phase3-resolve/lib/resolve.ps1
# How to get from (title, artist, album) to the correct Apple Music Song ID / URL
# without being given a URL.
#
# First candidate source: the PUBLIC, documented iTunes Search API (no credentials,
# no private endpoints). It also answers the key structural question: is the
# iTunes `trackId` the same identifier the Apple Music app uses in its song URLs?
#
# Reuses the FROZEN matching helpers from poc/lib/am-common.ps1 read-only
# (normalization + CJK-tolerant artist matching). The frozen play chain
# (am-play/am-uia/am-smtc) is not modified by this phase.
#
# ASCII-only on purpose (titles/artists come from candidates.json as UTF-8).
# ============================================================

$script:P3Root = $PSScriptRoot | Split-Path -Parent
$script:P3ExpRoot = $script:P3Root | Split-Path -Parent
. (Join-Path $script:P3ExpRoot 'poc\lib\am-common.ps1')

function Get-AmItunesHttp([string]$Uri, [int]$Retries = 3) {
  # iTunes answers with Content-Type text/javascript, which Windows PowerShell 5.1
  # does not auto-parse, so read the text and convert it explicitly.
  for ($i = 1; $i -le $Retries; $i++) {
    try {
      $raw = (Invoke-WebRequest -Uri $Uri -TimeoutSec 25 -UseBasicParsing -Headers @{ 'User-Agent' = 'mineradio-phase3-resolve' }).Content
      $j = $raw | ConvertFrom-Json
      return @{ ok = $true; json = $j; uri = $Uri; error = '' }
    } catch {
      if ($i -eq $Retries) { return @{ ok = $false; json = $null; uri = $Uri; error = $_.Exception.Message } }
      Start-Sleep -Milliseconds 400
    }
  }
}

function Invoke-AmItunesSearch {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Term,
    [string]$Entity = 'song',
    [int]$Limit = 25,
    [string]$Storefront = '',
    [string]$Attribute = ''
  )
  $uri = 'https://itunes.apple.com/search?term=' + [uri]::EscapeDataString($Term) + '&entity=' + $Entity + '&limit=' + $Limit
  if ($Attribute) { $uri += '&attribute=' + $Attribute }
  if ($Storefront) { $uri += '&country=' + $Storefront }
  $res = Get-AmItunesHttp $uri
  if (-not $res.ok) { return @{ ok = $false; results = @(); uri = $uri; error = $res.error } }
  $items = @()
  if ($res.json -and $res.json.results) { $items = @($res.json.results) }
  return @{ ok = $true; results = $items; uri = $uri; error = ''; count = $items.Count }
}

function Invoke-AmItunesLookup {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Id, [string]$Storefront = '', [string]$Entity = 'song')
  $uri = 'https://itunes.apple.com/lookup?id=' + [uri]::EscapeDataString($Id) + '&entity=' + $Entity
  if ($Storefront) { $uri += '&country=' + $Storefront }
  $res = Get-AmItunesHttp $uri
  if (-not $res.ok) { return @{ ok = $false; results = @(); uri = $uri; error = $res.error } }
  $items = @()
  if ($res.json -and $res.json.results) { $items = @($res.json.results) }
  return @{ ok = $true; results = $items; uri = $uri; error = ''; count = $items.Count }
}

# ------------------------------------------------------------
# scoring: title is the primary key, artist narrows/decides, album is a bonus
# ------------------------------------------------------------
function Get-AmSongCandidateScore {
  [CmdletBinding()]
  param($Item, [string]$Title, [string]$Artist = '', [string]$Album = '', [string]$WantArtist = '')
  $t = '' + $Item.trackName
  $a = '' + $Item.artistName
  $al = '' + $Item.collectionName
  $kind = '' + $Item.kind
  $wantArtistEff = $Artist
  if ($WantArtist) { $wantArtistEff = $WantArtist }

  $titleOk = Test-AmSmtcTitleMatch $t $Title
  $titleExact = ((Normalize-AmText $t) -eq (Normalize-AmText $Title))
  $artistOk = $true
  if ($wantArtistEff) { $artistOk = (Test-AmArtistLooseMatch $wantArtistEff $a) }
  $albumOk = $true
  if ($Album) { $albumOk = (Test-AmSmtcTitleMatch $al $Album) -or ((Normalize-AmText $al).Contains((Normalize-AmText $Album))) }

  $score = 0
  if ($titleExact) { $score += 8 } elseif ($titleOk) { $score += 4 }
  if ($artistOk -and $wantArtistEff) { $score += 6 }
  if ($albumOk -and $Album) { $score += 3 }
  if ($kind -eq 'song') { $score += 1 }

  return @{
    score = $score; titleOk = $titleOk; titleExact = $titleExact; artistOk = $artistOk; albumOk = $albumOk
    trackId = ('' + $Item.trackId); trackName = $t; artistName = $a; albumName = $al
    collectionId = ('' + $Item.collectionId); trackViewUrl = ('' + $Item.trackViewUrl)
    kind = $kind; trackNumber = ('' + $Item.trackNumber); releaseDate = ('' + $Item.releaseDate)
  }
}

function Get-AmCanonicalSongUrl([string]$SongId, [string]$Storefront = 'cn', [string]$Slug = 'song') {
  if (-not $Storefront) { $Storefront = 'cn' }
  if (-not $Slug) { $Slug = 'song' }
  return ('https://music.apple.com/' + $Storefront + '/song/' + $Slug + '/' + $SongId)
}

# ------------------------------------------------------------
# the resolver: strategy ladder, always reports its evidence
# ------------------------------------------------------------
function Resolve-AmSongId {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Artist = '',
    [string]$Album = '',
    [string]$Storefront = 'cn',
    [int]$Limit = 25,
    [string]$ArtistAlias = ''    # e.g. catalog name when the caller knows the real name
  )
  $steps = New-Object System.Collections.Generic.List[object]
  $wantArtist = $Artist
  if ($ArtistAlias) { $wantArtist = $ArtistAlias }
  $tried = @()
  $best = $null
  $allCands = @()

  $plan = @()
  if ($Artist -and $Album) { $plan += @{ kind = 'title+artist+album'; term = ($Title + ' ' + $Artist + ' ' + $Album) } }
  if ($Artist) { $plan += @{ kind = 'title+artist'; term = ($Title + ' ' + $Artist) } }
  $plan += @{ kind = 'title'; term = $Title }
  if ($Album) { $plan += @{ kind = 'title+album'; term = ($Title + ' ' + $Album) } }

  # Storefront ladder: the signed-in storefront first, then the other Chinese
  # storefronts and the default one. Measured: the cn SEARCH endpoint can return
  # nothing while cn LOOKUP works, and CJK titles are only found in tw/hk, so a
  # single storefront is not enough.
  $storefronts = @()
  foreach ($sf in @($Storefront, 'tw', 'hk', 'us', '')) {
    if ($storefronts -notcontains $sf) { $storefronts += $sf }
  }

  foreach ($p in $plan) {
    foreach ($sf in $storefronts) {
      $key = ($p.kind + '|sf=' + $sf)
      if ($tried -contains $key) { continue }
      $tried += $key
      $s = Invoke-AmItunesSearch -Term $p.term -Entity 'song' -Limit $Limit -Storefront $sf
      $step = [ordered]@{ step = $p.kind; storefront = $sf; term = $p.term; ok = $s.ok; count = 0; uri = $s.uri; error = $s.error }
      if (-not $s.ok) { $steps.Add([pscustomobject]$step); continue }
      $scored = @()
      foreach ($r in $s.results) {
        if (('' + $r.kind) -ne 'song') { continue }
        $scored += , (Get-AmSongCandidateScore -Item $r -Title $Title -Artist $Artist -Album $Album -WantArtist $wantArtist)
      }
      $scored = @($scored | Sort-Object -Property @{ Expression = { $_.score }; Descending = $true })
      $step.count = $scored.Count
      if ($scored.Count -gt 0) { $step.topScore = $scored[0].score; $step.topTitle = $scored[0].trackName; $step.topArtist = $scored[0].artistName; $step.topId = $scored[0].trackId }
      $steps.Add([pscustomobject]$step)
      foreach ($c in $scored) { if ($allCands.Count -lt 40) { $allCands += , $c } }
      if ($scored.Count -gt 0) {
        $b = $scored[0]
        # accept only when the title matches and (if an artist was requested) the artist matches
        if ($b.titleOk -and ((-not $wantArtist) -or $b.artistOk)) {
          $best = $b; $best['viaKind'] = $p.kind; $best['viaStorefront'] = $sf; $best['viaTerm'] = $p.term
          break
        }
      }
    }
    if ($best) { break }
  }

  $runnerUp = $null
  if ($allCands.Count -gt 1) { $runnerUp = $allCands[1] }

  $out = @{
    ok = $false; title = $Title; artist = $Artist; album = $Album; storefront = $Storefront
    songId = ''; collectionId = ''; songUrl = ''; trackViewUrl = ''
    matchedTitle = ''; matchedArtist = ''; matchedAlbum = ''
    score = 0; viaKind = ''; viaStorefront = ''; viaTerm = ''
    runnerUpId = ''; runnerUpArtist = ''; runnerUpTitle = ''
    steps = $steps; candidates = @($allCands | Select-Object -First 8)
  }
  if (-not $best) { return $out }

  $out.ok = $true
  $out.songId = $best.trackId
  $out.collectionId = $best.collectionId
  $out.matchedTitle = $best.trackName
  $out.matchedArtist = $best.artistName
  $out.matchedAlbum = $best.albumName
  $out.score = $best.score
  $out.viaKind = $best.viaKind
  $out.viaStorefront = $best.viaStorefront
  $out.viaTerm = $best.viaTerm
  $out.trackViewUrl = $best.trackViewUrl
  $out.songUrl = Get-AmCanonicalSongUrl $best.trackId $Storefront
  if ($runnerUp) { $out.runnerUpId = $runnerUp.trackId; $out.runnerUpArtist = $runnerUp.artistName; $out.runnerUpTitle = $runnerUp.trackName }
  return $out
}
