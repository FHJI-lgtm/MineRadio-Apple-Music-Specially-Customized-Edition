# ============================================================
# poc/lib/am-resolve.ps1
# Resolve "title + artist" to an Apple Music song page URL.
#
# Uses the PUBLIC, documented iTunes Search API (no credentials, no private
# endpoints, no reverse engineering). Resolution is done ONCE per test song and
# frozen into poc/songs.json, so the stability runs need no network at all.
# In MineRadio itself the song URL/track id is already known from its own
# metadata, so this step exists only for the experiment.
#
# ASCII-only on purpose.
# ============================================================

function Resolve-AmSongUrl {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Artist = '',
    [string]$Storefront = 'cn',
    [int]$Limit = 10
  )
  $term = $Title
  if ($Artist) { $term = ($Title + ' ' + $Artist) }
  $base = 'https://itunes.apple.com/search?term=' + [uri]::EscapeDataString($term) + '&entity=song&limit=' + $Limit
  # The storefront-scoped query can come back empty (observed for cn), so try the
  # storefront first and fall back to the default storefront.
  $urls = @()
  if ($Storefront) { $urls += ($base + '&country=' + $Storefront) }
  $urls += $base

  $out = @{ ok = $false; url = ''; trackId = ''; trackName = ''; artistName = ''; collectionName = ''; candidates = @(); error = ''; usedUri = '' }
  $resp = $null
  foreach ($u in $urls) {
    try {
      # iTunes replies with Content-Type text/javascript, which Windows PowerShell
      # 5.1 does not auto-parse - so read the text and convert it explicitly.
      $raw = (Invoke-WebRequest -Uri $u -TimeoutSec 25 -UseBasicParsing -Headers @{ 'User-Agent' = 'mineradio-apple-music-uia-experiment' }).Content
      $j = $raw | ConvertFrom-Json
      if ($j -and $j.results -and $j.results.Count -gt 0) { $resp = $j; $out.usedUri = $u; break }
    } catch { $out.error = ('request failed: ' + $_.Exception.Message) }
  }
  if (-not $resp -or -not $resp.results) { if (-not $out.error) { $out.error = 'no results' }; return $out }

  $scored = @()
  foreach ($r in $resp.results) {
    if (('' + $r.kind) -ne 'song') { continue }
    $titleOk = Test-AmSmtcTitleMatch ('' + $r.trackName) $Title
    $artistOk = $true
    if ($Artist) { $artistOk = (Test-AmArtistLooseMatch $Artist ('' + $r.artistName)) }
    $score = 0
    if ($titleOk) { $score += 2 }
    if ($artistOk) { $score += 4 }
    if (('' + $r.trackName) -eq $Title) { $score += 1 }
    $scored += , @{ score = $score; trackId = ('' + $r.trackId); url = ('' + $r.trackViewUrl); trackName = ('' + $r.trackName); artistName = ('' + $r.artistName); collection = ('' + $r.collectionName); titleOk = $titleOk; artistOk = $artistOk }
  }
  $scored = @($scored | Sort-Object -Property @{ Expression = { $_.score }; Descending = $true })
  $out.candidates = @($scored | ForEach-Object { @{ score = $_.score; trackId = $_.trackId; trackName = $_.trackName; artistName = $_.artistName; url = $_.url } })
  if ($scored.Count -eq 0) { $out.error = 'no song results'; return $out }
  $best = $scored[0]
  if (-not $best.titleOk -or ($Artist -and -not $best.artistOk)) {
    $out.error = 'no result matched title+artist'
    return $out
  }
  $out.ok = $true
  $out.url = $best.url
  # Do NOT rewrite the storefront segment of trackViewUrl: album/track ids are
  # storefront-specific, so substituting /us/ -> /cn/ points at a DIFFERENT track
  # (verified: it played a cover version). The API url is used verbatim; Apple
  # Music maps a foreign storefront link onto the signed-in storefront itself.
  $out.trackId = $best.trackId
  $out.trackName = $best.trackName
  $out.artistName = $best.artistName
  $out.collectionName = $best.collection
  return $out
}
