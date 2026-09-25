# ============================================================
# poc/analyze-e2e.ps1
# THE single source of truth for every E2E metric.  Nothing else may compute
# rates, wrong-acceptance counts or latencies: the runner writes raw per-song
# rows, this script derives all numbers from them.
#
# It is a post-hoc auditor: it never plays, never searches, never touches the
# network and never touches the frozen playback chain.  Identity/version/edition
# verdicts are recomputed here with the CORRECT helper signatures, so a buggy
# inline field in a runner cannot leak into a report.
#
# Historically wrong inline metrics this script deliberately recomputes:
#   * Test-AmSmtcArtistMatch(smtcArtist, targetArtist) - argument order matters
#   * Test-AmArtistLayer / Get-AmAlbumLayer / Get-AmTitleLayer return hashtables:
#     compare .score / .layer, never the object itself
#   * am-play.ps1 exposes no playback-only duration (t.totalMs does not exist)
#
# SMTC disagreement is split into two honestly-labelled buckets:
#   * EXPLAINED false negative - the frozen strict verifier cannot see a catalog
#     alias credit ("The Weeknd" vs "Abel Tesfaye") or a context annotation
#     ("Title" vs "Title (film theme)"); the correct track played.
#   * UNEXPLAINED - nothing accounts for it, so it stays a hard failure.
# ASCII-only on purpose.
# ============================================================
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Jsonl,
  [string]$OutDir = '',
  [string]$Label = 'e2e'
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot '..\phase3-resolve\lib\resolve35.ps1')

function Get-AmStats($values) {
  $v = @($values | Where-Object { $_ -ne $null } | Sort-Object)
  if ($v.Count -eq 0) { return @{ n = 0; mean = 0; p50 = 0; p95 = 0; max = 0 } }
  $sum = 0; foreach ($x in $v) { $sum += $x }
  $p50 = $v[[int][Math]::Floor(($v.Count - 1) * 0.5)]
  $i95 = [Math]::Min($v.Count - 1, [int][Math]::Ceiling($v.Count * 0.95) - 1)
  return @{ n = $v.Count; mean = [int]($sum / $v.Count); p50 = [int]$p50; p95 = [int]$v[$i95]; max = [int]$v[$v.Count - 1] }
}

$rows = @(Get-Content -Path $Jsonl -Encoding UTF8 | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_ | ConvertFrom-Json })
$total = $rows.Count
$resolved = @($rows | Where-Object { $_.resolveOk -eq $true })
$played = @($rows | Where-Object { ('' + $_.playback) -ne 'SKIPPED' })
$playOk = @($played | Where-Object { ('' + $_.playback) -eq 'OK' })
$autoPlayable = @($resolved | Where-Object { $_.autoPlayable -eq $true })
$refused = @($rows | Where-Object { $_.resolveOk -ne $true })

$wrongArtist = @(); $smtcStrictMismatch = @(); $editionDifferent = @(); $noncanonicalPlayed = @(); $wrongAlbumPlayed = @()
foreach ($r in $rows) {
  $reqArtist = '' + $r.artist
  $evArtist = '' + $r.lookupArtist
  if ($evArtist -eq '') { $evArtist = '' + $r.matchedArtist }
  if (($r.resolveOk -eq $true) -and $reqArtist -ne '' -and $evArtist -ne '') {
    if ([int](Test-AmArtistLayer $reqArtist $evArtist).score -eq 0) { $wrongArtist += ('' + $r.id) }
  }
  if (('' + $r.smtcArtist) -ne '' -and $reqArtist -ne '') {
    if ([int](Test-AmSmtcArtistMatch ('' + $r.smtcArtist) $reqArtist) -eq 0) { $smtcStrictMismatch += ('' + $r.id) }
  }
  if (($r.resolveOk -eq $true) -and ('' + $r.album) -ne '' -and ('' + $r.matchedAlbum) -ne '') {
    $al = Get-AmAlbumLayer ('' + $r.album) ('' + $r.matchedAlbum)
    if ([int]$al.score -le 0) {
      $na = Normalize-AmText ('' + $r.album); $nb = Normalize-AmText ('' + $r.matchedAlbum)
      if ($nb -notlike ('*' + $na + '*') -and $na -notlike ('*' + $nb + '*')) { $editionDifferent += ('' + $r.id) }
    }
  }
  if (('' + $r.playback) -eq 'OK') {
    if (-not (('' + $r.versionLayer) -in @('canonical', 'requested-version'))) { $noncanonicalPlayed += ('' + $r.id) }
    if (('' + $r.album) -ne '' -and -not (('' + $r.albumLayer) -in @('exact', 'exact-cjk'))) { $wrongAlbumPlayed += ('' + $r.id) }
  }
}

# Frozen-verifier blind spots, audited deterministically.  The playback chain is
# NOT modified: this only classifies a WRONG_TRACK report as explained/unexplained.
$smtcExplainedFN = @()
$smtcUnexplained = @()
$emDash = [string][char]0x2014
foreach ($r in $rows) {
  if (('' + $r.stage) -ne 'SMTC_WRONG_TRACK') { continue }
  $tl = Get-AmTitleLayer36 ('' + $r.title) ('' + $r.smtcTitle)
  $artistOnly = '' + $r.smtcArtist
  if ($artistOnly.Contains($emDash)) { $artistOnly = $artistOnly.Split($emDash)[0].Trim() }
  $artistOk = $true
  if (('' + $r.artist) -ne '' -and $artistOnly -ne '') { $artistOk = ([int](Test-AmArtistLayer ('' + $r.artist) $artistOnly).score -gt 0) }
  $titleOk = ($tl.layer -in @('exact', 'exact-context'))
  if ($titleOk -and $artistOk) { $smtcExplainedFN += ('' + $r.id) } else { $smtcUnexplained += ('' + $r.id) }
}

$taxonomy = @('RESOLVE_NOT_FOUND', 'RESOLVE_AMBIGUOUS', 'RESOLVE_WRONG_ARTIST', 'RESOLVE_WRONG_ALBUM', 'RESOLVE_WRONG_VERSION',
  'RESOLVE_LOW_CONFIDENCE', 'RESOLVE_NONCANONICAL_ONLY', 'LOOKUP_FAILED', 'URL_NAVIGATION_FAILED', 'TARGET_ROW_NOT_FOUND',
  'REALIZE_FAILED', 'BOUNDS_INVALID', 'CLICK_FAILED', 'SMTC_TIMEOUT', 'SMTC_WRONG_TRACK', 'APP_NOT_RUNNING')
$tax = [ordered]@{}
foreach ($t in $taxonomy) { $tax[$t] = @($rows | Where-Object { ('' + $_.stage) -eq $t }).Count }

$pbValues = @()
foreach ($r in $played) {
  $p = [int]$r.playbackMs
  if ($p -le 0) { $p = [Math]::Max(0, [int]$r.e2eMs - [int]$r.resolveMs) }
  $pbValues += $p
}
$resolveStats = Get-AmStats @($rows | ForEach-Object { [int]$_.resolveMs })
$playStats = Get-AmStats $pbValues
$e2eStats = Get-AmStats @($rows | ForEach-Object { [int]$_.e2eMs })
$smtcStats = Get-AmStats @($played | ForEach-Object { [int]$_.smtcMs })
$derivedPlayback = @($played | Where-Object { [int]$_.playbackMs -le 0 }).Count

$wrongVersionAuto = $noncanonicalPlayed.Count
$hardFailure = (($wrongArtist.Count + $smtcUnexplained.Count + $wrongVersionAuto + $wrongAlbumPlayed.Count) -gt 0)
$verifiedAudited = $playOk.Count + $smtcExplainedFN.Count
$summary = [ordered]@{
  label = $Label; jsonl = (Split-Path -Leaf $Jsonl); auditedAt = (Get-AmIsoNow)
  total = $total
  resolveSuccess = $resolved.Count; resolveRate = [int](100 * $resolved.Count / [Math]::Max(1, $total))
  autoPlayable = $autoPlayable.Count
  playbackAttempted = $played.Count
  playbackSuccess = $playOk.Count; playbackRate = [int](100 * $playOk.Count / [Math]::Max(1, $played.Count))
  e2eSuccess = $playOk.Count; e2eRate = [int](100 * $playOk.Count / [Math]::Max(1, $total))
  smtcExplainedFalseNegatives = $smtcExplainedFN.Count; smtcExplainedIds = $smtcExplainedFN
  smtcUnexplainedMismatch = $smtcUnexplained.Count; smtcUnexplainedIds = $smtcUnexplained
  smtcStrictMismatch = $smtcStrictMismatch.Count; smtcStrictMismatchIds = $smtcStrictMismatch
  playbackVerifiedAudited = $verifiedAudited
  playbackRateAudited = [int](100 * $verifiedAudited / [Math]::Max(1, $played.Count))
  e2eRateAudited = [int](100 * $verifiedAudited / [Math]::Max(1, $total))
  wrongArtistAcceptances = $wrongArtist.Count; wrongArtistIds = $wrongArtist
  wrongVersionAutomaticAcceptance = $wrongVersionAuto; wrongVersionIds = $noncanonicalPlayed
  wrongAlbumAutoplayed = $wrongAlbumPlayed.Count; wrongAlbumIds = $wrongAlbumPlayed
  editionDifferentFromRequest = $editionDifferent.Count; editionDifferentIds = $editionDifferent
  hardFailure = $hardFailure
  resolveMs = $resolveStats; playbackMs = $playStats; e2eMs = $e2eStats; smtcMs = $smtcStats
  playbackMsDerivedCount = $derivedPlayback
  taxonomy = $tax
  refusalCodes = (@($refused | ForEach-Object { '' + $_.code } | Sort-Object -Unique) -join ',')
}

Write-Host ('== authoritative metrics (' + $Label + ') ==')
Write-Host ('total=' + $total + ' resolve=' + $summary.resolveSuccess + '/' + $total + ' (' + $summary.resolveRate + '%) autoPlayable=' + $summary.autoPlayable + ' playback=' + $summary.playbackSuccess + '/' + $summary.playbackAttempted + ' (' + $summary.playbackRate + '%) e2e=' + $summary.e2eSuccess + '/' + $total + ' (' + $summary.e2eRate + '%)')
Write-Host ('WRONG_ARTIST_ACCEPTANCES=' + $wrongArtist.Count + '  WRONG_VERSION_AUTOMATIC_ACCEPTANCE=' + $wrongVersionAuto + '  WRONG_ALBUM_AUTOPLAYED=' + $wrongAlbumPlayed.Count)
Write-Host ('SMTC_EXPLAINED_FALSE_NEGATIVES=' + $smtcExplainedFN.Count + ' ' + ($smtcExplainedFN -join ',') + ' (correct track played; the frozen strict verifier cannot see a catalog alias credit or a context annotation)')
Write-Host ('SMTC_UNEXPLAINED_MISMATCH=' + $smtcUnexplained.Count + ' ' + ($smtcUnexplained -join ','))
Write-Host ('SMTC_STRICT_MISMATCH_INFO=' + $smtcStrictMismatch.Count + ' ' + ($smtcStrictMismatch -join ','))
Write-Host ('playbackVerifiedAudited=' + $verifiedAudited + '/' + $played.Count + ' (' + $summary.playbackRateAudited + '%)  e2eRateAudited=' + $summary.e2eRateAudited + '%')
Write-Host ('edition different from an explicitly requested album: ' + $editionDifferent.Count + ' ' + ($editionDifferent -join ','))
Write-Host ('latency resolve p50=' + $resolveStats.p50 + ' p95=' + $resolveStats.p95 + ' max=' + $resolveStats.max + ' | playback p50=' + $playStats.p50 + ' p95=' + $playStats.p95 + ' max=' + $playStats.max + '(derived ' + $derivedPlayback + ') | e2e p50=' + $e2eStats.p50 + ' p95=' + $e2eStats.p95 + ' max=' + $e2eStats.max)
$parts = @(); foreach ($k in $tax.Keys) { if ($tax[$k] -gt 0) { $parts += ($k + '=' + $tax[$k]) } }
Write-Host ('failure taxonomy: ' + ($parts -join ', '))
if ($hardFailure) { Write-Host 'VERDICT: HARD FAILURE (a wrong artist / wrong version / wrong album was accepted, or SMTC disagreed without explanation)'; } else { Write-Host 'VERDICT: no wrong acceptance' }

if ($OutDir -ne '') {
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
  $stamp = Get-AmStamp
  Write-AmJsonFile (Join-Path $OutDir ($Label + '-' + $stamp + '-metrics.json')) $summary
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('# Authoritative E2E metrics (' + $Label + ' / ' + $summary.jsonl + ')')
  $lines.Add('')
  $lines.Add('| metric | value |')
  $lines.Add('|---|---|')
  foreach ($k in @('total', 'resolveSuccess', 'autoPlayable', 'playbackAttempted', 'playbackSuccess', 'playbackVerifiedAudited', 'e2eSuccess', 'smtcExplainedFalseNegatives', 'smtcUnexplainedMismatch', 'wrongArtistAcceptances', 'wrongVersionAutomaticAcceptance', 'wrongAlbumAutoplayed', 'editionDifferentFromRequest', 'hardFailure')) { $lines.Add('| ' + $k + ' | ' + $summary[$k] + ' |') }
  $lines.Add('| resolveRate | ' + $summary.resolveRate + '% |')
  $lines.Add('| playbackRate | ' + $summary.playbackRate + '% |')
  $lines.Add('| e2eRate | ' + $summary.e2eRate + '% |')
  $lines.Add('| playbackRateAudited | ' + $summary.playbackRateAudited + '% |')
  $lines.Add('| e2eRateAudited | ' + $summary.e2eRateAudited + '% |')
  $lines.Add('| resolveMs | p50=' + $resolveStats.p50 + ' p95=' + $resolveStats.p95 + ' max=' + $resolveStats.max + ' mean=' + $resolveStats.mean + ' |')
  $lines.Add('| playbackMs | p50=' + $playStats.p50 + ' p95=' + $playStats.p95 + ' max=' + $playStats.max + ' mean=' + $playStats.mean + ' |')
  $lines.Add('| e2eMs | p50=' + $e2eStats.p50 + ' p95=' + $e2eStats.p95 + ' max=' + $e2eStats.max + ' mean=' + $e2eStats.mean + ' |')
  $lines.Add('| smtcMs | p50=' + $smtcStats.p50 + ' p95=' + $smtcStats.p95 + ' max=' + $smtcStats.max + ' |')
  $lines.Add('')
  $lines.Add('## Failure taxonomy')
  foreach ($k in $tax.Keys) { if ($tax[$k] -gt 0) { $lines.Add('- ' + $k + ' = ' + $tax[$k]) } }
  Write-AmText (Join-Path $OutDir ($Label + '-' + $stamp + '-metrics.md')) ($lines -join "`r`n")
}
return $summary
