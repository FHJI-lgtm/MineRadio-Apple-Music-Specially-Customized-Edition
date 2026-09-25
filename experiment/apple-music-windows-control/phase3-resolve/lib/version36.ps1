# ============================================================
# phase3-resolve/lib/version36.ps1   (Phase 3.6: version semantics + precision)
#
# A deterministic layer on top of title / artist / album:
#   * explicit version markers -> inside () [] {} or after a dash in the TRACK title
#     ("Title(Live)", "Title (Acoustic)", "Title (Remix)")
#   * weak version markers     -> the ALBUM name carries a performance context
#     (concert / live / variety-show episode / compilation / soundtrack ...)
#   * context annotations      -> film / drama / collab notes inside () are NOT version
#     markers (movie theme, feat. X, "From the movie ...").  They are stripped before
#     comparing titles, which keeps a film-theme single the plain release.
#
# Policy:
#   - a canonical request (no version asked for) prefers a canonical candidate;
#     a lone non-canonical candidate may still win, but never as a playable result
#   - an explicit album request always outranks the version heuristic
#   - equal score across DIFFERENT recordings -> AMBIGUOUS (never array order)
#   - one recording behind several ids -> deterministic storefront pick, not ambiguous
#
# Pure functions only: no network here.  The resolver and the offline unit tests both
# call New-AmCandidate / Select-AmBestCandidate, so scoring can never diverge.
#
# ASCII-only on purpose: every CJK marker lives in version36-markers.json, because
# PowerShell 5.1 parses BOM-less scripts as ANSI.
# ============================================================

$script:AmVersionData = (Get-Content -Path (Join-Path $PSScriptRoot 'version36-markers.json') -Raw -Encoding UTF8 | ConvertFrom-Json)

$script:AmVersionAscii = @(
  @{ cls = 'live';         ascii = @('live', 'unplugged', 'concert', 'in concert') },
  @{ cls = 'show';         ascii = @('episode') },
  @{ cls = 'acoustic';     ascii = @('acoustic') },
  @{ cls = 'remix';        ascii = @('remix', 'mashup', 'bootleg', 'club mix') },
  @{ cls = 'remaster';     ascii = @('remaster', 'remastered') },
  @{ cls = 'rerecorded';   ascii = @('re-recorded', 'rerecorded', 'new version') },
  @{ cls = 'instrumental'; ascii = @('instrumental', 'backing track') },
  @{ cls = 'karaoke';      ascii = @('karaoke') },
  @{ cls = 'demo';         ascii = @('demo') },
  @{ cls = 'radio';        ascii = @('radio edit', 'radio version') },
  @{ cls = 'extended';     ascii = @('extended') },
  @{ cls = 'ost';          ascii = @('ost', 'soundtrack', 'original motion picture') },
  @{ cls = 'compilation';  ascii = @('compilation', 'greatest hits', 'best of', 'anthology') }
)

$script:AmVersionMarkers = @()
foreach ($m in $script:AmVersionAscii) {
  $cjk = @()
  $p = $script:AmVersionData.markers.PSObject.Properties[$m.cls]
  if ($p) { $cjk = @($p.Value) }
  $script:AmVersionMarkers += , @{ cls = $m.cls; ascii = $m.ascii; cjk = $cjk }
}
$script:AmContextAnnotations = @($script:AmVersionData.contextAnnotations)
$script:AmShowEpisodeRegex = '' + $script:AmVersionData.showEpisodeRegex

function Test-AmVersionMarker($marker, [string]$lower) {
  foreach ($a in $marker.ascii) {
    if ($lower.Contains($a)) {
      if ($a.Length -le 4) {
        if (-not ([regex]::IsMatch($lower, '(^|[^a-z])' + [regex]::Escape($a) + '([^a-z]|$)'))) { continue }
      }
      return $true
    }
  }
  foreach ($c in $marker.cjk) { if ($lower.Contains($c.ToLowerInvariant())) { return $true } }
  return $false
}

function Test-AmParentheticalIsContext([string]$group) {
  $gl = $group.ToLowerInvariant()
  $isContext = $false
  foreach ($c in $script:AmContextAnnotations) { if ($gl.Contains($c)) { $isContext = $true; break } }
  if (-not $isContext) { return $false }
  foreach ($mk in $script:AmVersionMarkers) { if (Test-AmVersionMarker $mk $gl) { return $false } }
  return $true
}

# Removes only CONTEXT parentheticals, so "Title (Live)" keeps its marker while
# "Title (movie theme)" collapses onto "Title".
function Remove-AmContextAnnotations([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $text }
  $out = $text
  foreach ($m in [regex]::Matches($text, '[\(\[\{]([^\)\]\}]*)[\)\]\}]')) {
    if (Test-AmParentheticalIsContext $m.Groups[1].Value) { $out = $out.Replace($m.Value, ' ') }
  }
  return $out
}

function Get-AmVersionClassesFromText([string]$Text, [switch]$IsAlbum) {
  $explicit = New-Object System.Collections.Generic.List[string]
  $weak = New-Object System.Collections.Generic.List[string]
  if ([string]::IsNullOrEmpty($Text)) { return @{ explicit = @(); weak = @() } }
  $lower = $Text.ToLowerInvariant()

  foreach ($m in [regex]::Matches($Text, '[\(\[\{]([^\)\]\}]*)[\)\]\}]')) {
    $g = $m.Groups[1].Value
    $gl = $g.ToLowerInvariant()
    $hit = @()
    foreach ($mk in $script:AmVersionMarkers) { if (Test-AmVersionMarker $mk $gl) { $hit += $mk.cls } }
    if ($hit.Count -eq 0) { continue }
    if (Test-AmParentheticalIsContext $g) {
      foreach ($h in $hit) { if ($weak -notcontains $h) { $weak.Add($h) } }
    } else {
      foreach ($h in $hit) { if ($explicit -notcontains $h) { $explicit.Add($h) } }
    }
  }
  # a dash suffix such as "Title - Live at Wembley" is an explicit marker too
  $dash = [regex]::Match($lower, '\s+-\s+(.+)$')
  if ($dash.Success) {
    $tail = $dash.Groups[1].Value
    $isContext = $false
    foreach ($c in $script:AmContextAnnotations) { if ($tail.Contains($c)) { $isContext = $true; break } }
    if (-not $isContext) {
      foreach ($mk in $script:AmVersionMarkers) {
        if (Test-AmVersionMarker $mk $tail) { if ($explicit -notcontains $mk.cls) { $explicit.Add($mk.cls) } }
      }
    }
  }
  if ($IsAlbum) {
    foreach ($mk in $script:AmVersionMarkers) {
      if (Test-AmVersionMarker $mk $lower) {
        if ($mk.cls -eq 'show') {
          # only a real variety-show episode ("ep. 5"), never a bare episode character
          if (-not ([regex]::IsMatch($Text, $script:AmShowEpisodeRegex))) { continue }
        }
        if ($explicit -notcontains $mk.cls -and $weak -notcontains $mk.cls) { $weak.Add($mk.cls) }
      }
    }
  }
  return @{ explicit = @($explicit); weak = @($weak) }
}

function Get-AmVersionRequest([string]$Title, [string]$Album) {
  $t = Get-AmVersionClassesFromText $Title
  $classes = New-Object System.Collections.Generic.List[string]
  foreach ($c in $t.explicit) { $classes.Add($c) }
  foreach ($c in $t.weak) { if (-not $classes.Contains($c)) { $classes.Add($c) } }
  if ($Album) {
    $a = Get-AmVersionClassesFromText $Album -IsAlbum
    foreach ($c in @($a.explicit) + @($a.weak)) { if (-not $classes.Contains($c)) { $classes.Add($c) } }
  }
  return @{ classes = @($classes); canonical = ($classes.Count -eq 0) }
}

function Get-AmVersionLayer([string]$Title, [string]$Album, [string]$RequestTitle, [string]$RequestAlbum) {
  $req = Get-AmVersionRequest $RequestTitle $RequestAlbum
  $t = Get-AmVersionClassesFromText $Title
  $a = Get-AmVersionClassesFromText $Album -IsAlbum
  $classes = New-Object System.Collections.Generic.List[string]
  foreach ($c in $t.explicit) { if (-not $classes.Contains($c)) { $classes.Add($c) } }
  foreach ($c in $t.weak) { if (-not $classes.Contains($c)) { $classes.Add($c) } }
  foreach ($c in $a.explicit) { if (-not $classes.Contains($c)) { $classes.Add($c) } }
  foreach ($c in $a.weak) { if (-not $classes.Contains($c)) { $classes.Add($c) } }
  $candClasses = @($classes)
  $candCanonical = ($t.explicit.Count -eq 0 -and $t.weak.Count -eq 0 -and $a.explicit.Count -eq 0 -and $a.weak.Count -eq 0)
  $res = @{ ok = $true; layer = 'canonical'; score = 0; canonical = $candCanonical; match = $false; classes = $candClasses; requestClasses = @($req.classes); reason = '' }

  if ($req.classes.Count -gt 0) {
    $hit = @($candClasses | Where-Object { $req.classes -contains $_ })
    if ($hit.Count -gt 0) {
      $res.layer = 'requested-version'; $res.score = 6; $res.match = $true; $res.canonical = $false
      $res.reason = 'carries the requested version'
      return $res
    }
    if ($candCanonical) {
      $res.layer = 'not-requested-version'; $res.score = -4; $res.ok = $false
      $res.reason = 'request asked for a specific version; this is the plain one'
      return $res
    }
    $res.layer = 'other-version'; $res.score = -5; $res.ok = $false
    $res.reason = 'a different version than the one requested'
    return $res
  }

  if ($candCanonical) { $res.layer = 'canonical'; $res.score = 6; $res.reason = 'plain studio-style release'; return $res }
  if ($t.explicit.Count -gt 0) { $res.layer = 'noncanonical-explicit'; $res.score = -6; $res.reason = 'explicit version marker in the title'; return $res }
  $res.layer = 'noncanonical-weak'; $res.score = -2; $res.reason = 'performance-context release (live / show / compilation)'
  return $res
}

# Title comparison that tolerates CONTEXT annotations on either side.
function Get-AmTitleLayer36([string]$want, [string]$got) {
  $base = Get-AmTitleLayer $want $got
  if ($base.layer -eq 'exact') { return $base }
  $w = Remove-AmContextAnnotations $want
  $g = Remove-AmContextAnnotations $got
  if ($w -and $g) {
    $nw = Normalize-AmText $w; $ng = Normalize-AmText $g
    if ($nw -and $ng) {
      if ($nw -eq $ng) { return @{ ok = $true; layer = 'exact-context'; score = 8 } }
      if ($ng.StartsWith($nw)) { return @{ ok = $true; layer = 'prefix'; score = 5 } }
      if ($ng.Contains($nw)) { return @{ ok = $true; layer = 'contains'; score = 3 } }
    }
  }
  return $base
}

$script:AmTitleRank = @{ 'exact' = 4; 'exact-context' = 4; 'prefix' = 3; 'contains' = 2; 'none' = 0 }
$script:AmArtistRank = @{ 'exact' = 5; 'normalized' = 4; 'not-requested' = 4; 'alias' = 3; 'cjk' = 2; 'none' = 0 }
$script:AmAlbumRank = @{ 'exact' = 4; 'exact-cjk' = 3; 'not-requested' = 3; 'contains' = 2; 'none' = 0 }

function New-AmCandidate {
  param(
    [string]$TrackId = '', [string]$CollectionId = '', [string]$Title = '', [string]$Artist = '',
    [string]$Album = '', [string]$Storefront = '', [string]$Strategy = '', [int]$TrackNumber = 0,
    [string]$RequestTitle = '', [string]$RequestArtist = '', [string]$RequestAlbum = '',
    [bool]$LookupConfirmed = $false, [string]$LookupTitle = '', [string]$LookupArtist = '', [string]$LookupAlbum = ''
  )
  $t = Get-AmTitleLayer36 $RequestTitle $Title
  $a = Test-AmArtistLayer $RequestArtist $Artist
  $al = Get-AmAlbumLayer $RequestAlbum $Album
  $v = Get-AmVersionLayer $Title $Album $RequestTitle $RequestAlbum
  $score = $t.score + $a.score + $al.score + $v.score
  $scoreWithEvidence = $score
  $evOk = $false
  if ($LookupConfirmed) {
    $lt = Get-AmTitleLayer36 $RequestTitle $LookupTitle
    $la = Test-AmArtistLayer $RequestArtist $LookupArtist
    $lal = Get-AmAlbumLayer $RequestAlbum $LookupAlbum
    $lv = Get-AmVersionLayer $LookupTitle $LookupAlbum $RequestTitle $RequestAlbum
    $evOk = ($lt.ok -and $la.ok -and $lal.ok -and $lv.ok)
    if ($evOk) { $scoreWithEvidence = $score + 2 }
    # the authoritative lookup answers the "what is this really" questions
    $t = $lt; $a = $la; $al = $lal; $v = $lv
  }
  $key = ((Normalize-AmText $Title) + '|' + (Normalize-AmText $Album))
  return @{
    trackId = $TrackId; collectionId = $CollectionId; title = $Title; artist = $Artist; album = $Album
    storefront = $Storefront; strategy = $Strategy; trackNumber = $TrackNumber
    titleLayer = $t.layer; titleScore = $t.score; artistLayer = $a.layer; artistScore = $a.score
    albumLayer = $al.layer; albumScore = $al.score; albumExact = $al.exact
    versionLayer = $v.layer; versionScore = $v.score; versionCanonical = $v.canonical; versionMatch = $v.match
    versionClasses = $v.classes; versionReason = $v.reason
    score = $score; scoreWithEvidence = $scoreWithEvidence; recordingKey = $key
    lookupConfirmed = $LookupConfirmed; lookupEvidenceOk = $evOk
    lookupTitle = $LookupTitle; lookupArtist = $LookupArtist; lookupAlbum = $LookupAlbum
  }
}

function Sort-AmCandidates($Candidates) {
  return @($Candidates | Sort-Object -Property `
      @{ Expression = { $_.scoreWithEvidence }; Descending = $true }, `
      @{ Expression = { $_.score }; Descending = $true }, `
      @{ Expression = { [int]$script:AmAlbumRank[$_.albumLayer] }; Descending = $true }, `
      @{ Expression = { [int]$script:AmTitleRank[$_.titleLayer] }; Descending = $true }, `
      @{ Expression = { [int]$script:AmArtistRank[$_.artistLayer] }; Descending = $true }, `
      @{ Expression = { [int]$_.trackNumber }; Ascending = $true }, `
      @{ Expression = { $_.trackId }; Ascending = $true })
}

# Pure selection. No network, no side effects.
function Select-AmBestCandidate {
  param(
    [object[]]$Candidates, [string]$RequestAlbum = '', [string]$RequestTitle = '',
    [string]$Storefront = 'cn', [string[]]$Ladder = @('cn', 'tw', 'hk', 'us', '')
  )
  $res = @{ ok = $false; ambiguous = $false; reason = 'RESOLVE_NOT_FOUND'; winner = $null; runnerUp = $null
            poolSize = 0; inputSize = 0; distinctRecordings = 0; choseCanonical = $false; tie = $false; notes = @() }
  $pool = @($Candidates | Where-Object { $_ -ne $null -and $_.trackId })
  if ($pool.Count -eq 0) { return $res }
  $res.inputSize = $pool.Count

  # 1. an explicitly requested album always outranks every other consideration
  if ($RequestAlbum) {
    $ex = @($pool | Where-Object { $_.albumExact })
    if ($ex.Count -gt 0) { $pool = $ex; $res.notes += 'exact album request honoured first' }
  }
  # 2. version policy
  $req = Get-AmVersionRequest $RequestTitle $RequestAlbum
  if ($req.canonical) {
    $canon = @($pool | Where-Object { $_.versionCanonical })
    if ($canon.Count -gt 0) { $pool = $canon; $res.choseCanonical = $true }
    else { $res.notes += 'no canonical candidate: a non-studio version may be accepted' }
  } else {
    $vm = @($pool | Where-Object { $_.versionMatch })
    if ($vm.Count -gt 0) { $pool = $vm }
  }
  $res.poolSize = $pool.Count

  # @() is mandatory: a single-element array is unrolled on return, and a Hashtable
  # indexed with [0] would yield $null instead of the candidate
  $sorted = @(Sort-AmCandidates $pool)
  $top = $sorted[0]
  $topScore = $top.scoreWithEvidence
  $tied = @($sorted | Where-Object { $_.scoreWithEvidence -eq $topScore })
  $distinct = @($tied | ForEach-Object { $_.recordingKey } | Sort-Object -Unique)
  $res.distinctRecordings = $distinct.Count

  if ($tied.Count -gt 1 -and $distinct.Count -gt 1) {
    # equal evidence across genuinely different recordings -> refuse, never guess
    $res.ambiguous = $true; $res.reason = 'RESOLVE_AMBIGUOUS'; $res.tie = $true
    $res.winner = $top; $res.runnerUp = $tied[1]
    return $res
  }

  $winner = $top
  if ($tied.Count -gt 1) {
    # one recording behind several ids: deterministic storefront preference
    $ordered = @($tied | Sort-Object -Property `
        @{ Expression = { $i = [array]::IndexOf($Ladder, $_.storefront); if ($i -lt 0) { 99 } else { $i } }; Ascending = $true }, `
        @{ Expression = { $_.trackId }; Ascending = $true })
    $winner = $ordered[0]
    $res.tie = $true
    $res.notes += ('same recording behind ' + $tied.Count + ' ids: deterministic storefront pick')
  }
  $res.ok = $true; $res.winner = $winner
  foreach ($c in $sorted) { if ($c.trackId -ne $winner.trackId) { $res.runnerUp = $c; break } }
  return $res
}

function Get-AmConfidence {
  param(
    $Winner, $Selection,
    [string]$RequestTitle = '', [string]$RequestArtist = '', [string]$RequestAlbum = '',
    [bool]$LookupPerformed = $false, [bool]$LookupOk = $false,
    [string]$LookupTitle = '', [string]$LookupArtist = '', [string]$LookupAlbum = ''
  )
  if ($Selection.ambiguous) { return 'AMBIGUOUS' }
  if ($Winner -eq $null) { return 'NOT_FOUND' }
  $srcTitle = $Winner.title; $srcArtist = $Winner.artist; $srcAlbum = $Winner.album
  if ($LookupPerformed -and $LookupOk) { $srcTitle = $LookupTitle; $srcArtist = $LookupArtist; $srcAlbum = $LookupAlbum }
  $t = Get-AmTitleLayer36 $RequestTitle $srcTitle
  $a = Test-AmArtistLayer $RequestArtist $srcArtist
  $al = Get-AmAlbumLayer $RequestAlbum $srcAlbum
  $albumOk = ((-not $RequestAlbum) -or ($al.layer -in @('exact', 'exact-cjk')))
  $exactTitle = ($t.layer -in @('exact', 'exact-context'))
  $goodArtist = ($a.layer -in @('exact', 'normalized'))
  $versionOk = ($Winner.versionLayer -in @('canonical', 'requested-version'))
  $noTie = (-not $Selection.tie)

  if (-not $versionOk -and ($Winner.versionLayer -eq 'other-version')) { return 'LOW' }
  if ($exactTitle -and $goodArtist -and $albumOk -and $versionOk -and $noTie) { $conf = 'HIGH' }
  elseif ($exactTitle -and ($a.layer -in @('alias', 'cjk')) -and $albumOk -and $versionOk) { $conf = 'MEDIUM' }
  elseif ($exactTitle -and $albumOk -and $Winner.versionCanonical) { $conf = 'MEDIUM' }
  elseif ($exactTitle -and $al.layer -eq 'contains') { $conf = 'MEDIUM' }
  else { $conf = 'LOW' }
  if (-not $versionOk -and $conf -eq 'HIGH') { $conf = 'MEDIUM' }
  if ($LookupPerformed -and -not $LookupOk) { $conf = 'LOW' }
  return $conf
}
