# ============================================================
# phase3-resolve/id-correspondence.ps1
# Is the iTunes `trackId` the same identifier Apple Music uses in its song URLs?
#
# Three independent checks:
#   P1 lookup id -> track   : feed a KNOWN Apple Music song id into the lookup API
#                             (default / us / cn / tw storefronts) and see whether the
#                             same id comes back as the same recording.
#   P2 search -> id         : resolve the three verified songs by search and compare
#                             the returned id with the known Apple Music id.
#   P3 URL form in the app  : navigate Apple Music with three URL forms for the same
#                             id (verified album form, canonical /song/<slug>/<id>,
#                             and a deliberately different slug) and check through UIA
#                             which ones reach a page containing the target row.
#                             Navigation only - nothing is clicked, nothing is played.
#
# ASCII-only on purpose.
# ============================================================
[CmdletBinding()]
param([string]$Storefront = 'cn')

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\resolve.ps1')
. (Join-Path $PSScriptRoot '..\poc\lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot '..\poc\lib\am-uia.ps1')

$findings = Join-Path $PSScriptRoot '..\findings\phase3'
if (-not (Test-Path $findings)) { New-Item -ItemType Directory -Force -Path $findings | Out-Null }
$stamp = Get-AmStamp
$jsonl = Join-Path $findings ('id-correspondence-' + $stamp + '.jsonl')
$md = Join-Path $findings ('id-correspondence-' + $stamp + '.md')
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $lines.Add($t); Write-Host $t }

# the three ids independently confirmed by a WORKING play URL (UTF-8 JSON, so this
# script itself stays ASCII-only - Windows PowerShell 5.1 would mis-parse CJK bytes
# inside a BOM-less .ps1)
$knownCfg = Get-Content -Path (Join-Path $PSScriptRoot 'known-songs.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$known = @($knownCfg.songs)

Say ('# ID correspondence ' + $stamp)
Say ''
Say ('known Apple Music song ids: ' + (($known | ForEach-Object { $_.amId }) -join ', '))
Say ''
Say '## P1: lookup(known id) across storefronts'
Say ''
Say '| song | id fed in | storefront | returned trackId | same id | track | artist |'
Say '|---|---|---|---|---|---|---|'

foreach ($k in $known) {
  foreach ($sf in @('', 'us', 'cn', 'tw')) {
    $r = Invoke-AmItunesLookup -Id $k.amId -Storefront $sf -Entity 'song'
    $first = $null
    if ($r.ok -and $r.count -gt 0) { $first = $r.results[0] }
    $rid = ''
    $tname = ''
    $aname = ''
    if ($first) { $rid = '' + $first.trackId; $tname = '' + $first.trackName; $aname = '' + $first.artistName }
    $label = $sf
    if (-not $label) { $label = '(default)' }
    $same = ($rid -eq $k.amId)
    Say ('| ' + $k.id + ' | ' + $k.amId + ' | ' + $label + ' | ' + $rid + ' | ' + $same + ' | ' + $tname + ' | ' + $aname + ' |')
    Add-AmJsonLine $jsonl ([ordered]@{ part = 'P1'; song = $k.id; knownId = $k.amId; storefront = $label; ok = $r.ok; count = $r.count; returnedId = $rid; sameId = $same; trackName = $tname; artistName = $aname; error = $r.error; ts = (Get-AmIsoNow) })
  }
}

Say ''
Say '## P2: search(title, artist) -> id  vs the known Apple Music id'
Say ''
Say '| song | via | resolved id | same as known | matched artist | matched album | runner-up |'
Say '|---|---|---|---|---|---|---|'

foreach ($k in $known) {
  foreach ($mode in @('as-defined', 'title-only', 'with-catalog-artist-alias')) {
    $artistArg = $k.artist
    $aliasArg = ''
    if ($mode -eq 'title-only') { $artistArg = '' }
    if ($mode -eq 'with-catalog-artist-alias') { $artistArg = $k.artist; $aliasArg = $k.wantArtist }
    $res = Resolve-AmSongId -Title $k.title -Artist $artistArg -Storefront $Storefront -ArtistAlias $aliasArg
    $same = ($res.songId -eq $k.amId)
    Say ('| ' + $k.id + ' | ' + $mode + ' | ' + $res.songId + ' | ' + $same + ' | ' + $res.matchedArtist + ' | ' + $res.matchedAlbum + ' | ' + $res.runnerUpArtist + ' / ' + $res.runnerUpTitle + ' |')
    Add-AmJsonLine $jsonl ([ordered]@{
        part = 'P2'; song = $k.id; mode = $mode; knownId = $k.amId; ok = $res.ok; resolvedId = $res.songId; sameId = $same
        viaKind = $res.viaKind; viaStorefront = $res.viaStorefront; matchedTitle = $res.matchedTitle; matchedArtist = $res.matchedArtist
        matchedAlbum = $res.matchedAlbum; runnerUpId = $res.runnerUpId; runnerUpArtist = $res.runnerUpArtist; runnerUpTitle = $res.runnerUpTitle
        songUrl = $res.songUrl; ts = (Get-AmIsoNow)
      })
  }
}

Say ''
Say '## P3: URL forms for the same id (navigation + UIA row check, nothing clicked)'
Say ''
Say '| song | url form | navigated | target row found | row name |'
Say '|---|---|---|---|---|'

$p = Get-AmProcess
if (-not $p) { [void](Ensure-AmRunning 30000); $p = Get-AmProcess }
$hwnd = [IntPtr]::Zero
if ($p) { $hwnd = $p.MainWindowHandle }
Restore-AmWindow $hwnd | Out-Null
Invoke-AmForeground $hwnd
$rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

$target = $known[0]
$forms = @(
  @{ name = 'verified-album-form'; url = $target.verifiedUrl },
  @{ name = 'canonical-song-form'; url = (Get-AmCanonicalSongUrl $target.amId $Storefront 'how-do-i-make-you-love-me') },
  @{ name = 'different-slug'; url = (Get-AmCanonicalSongUrl $target.amId $Storefront 'zzz-does-not-matter') }
)
foreach ($f in $forms) {
  $sigBefore = Get-AmTreeSignature $rootEl
  $nav = Invoke-AmNavigateUrl $f.url
  $navigated = $false
  $rowName = ''
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 12000) {
    Start-Sleep -Milliseconds 400
    if ((Get-AmTreeSignature $rootEl) -ne $sigBefore) { $navigated = $true }
    $items = Get-AmListItems $rootEl
    foreach ($it in $items) {
      $r = $null
      try { $r = $it.element.Current.BoundingRectangle } catch { $r = $null }
      if ($r -and -not $r.IsEmpty -and (Get-AmTitleScore $it.name $target.title) -ge 1) { $rowName = $it.name; break }
    }
    if ($rowName) { break }
  }
  $found = [bool]$rowName
  Say ('| ' + $target.id + ' | ' + $f.name + ' | ' + $navigated + ' | ' + $found + ' | ' + (Truncate-AmText $rowName 60) + ' |')
  Add-AmJsonLine $jsonl ([ordered]@{ part = 'P3'; song = $target.id; form = $f.name; url = $f.url; navMethod = $nav.method; navigated = $navigated; rowFound = $found; rowName = $rowName; ts = (Get-AmIsoNow) })
  Start-Sleep -Milliseconds 500
}

Write-AmText $md ($lines -join "`r`n")
Write-Host ''
Write-Host ('report: ' + $md)
Write-Host ('jsonl : ' + $jsonl)
