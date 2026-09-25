# ============================================================
# phase3.7C-virtual-desktop/run-vd-poc.ps1
# Manual-desktop PoC: can A-uia operate Apple Music while it sits on ANOTHER virtual
# desktop, without switching the user's desktop?
#
# The virtual desktops are prepared BY HAND by the user (this script never creates,
# deletes or moves anything).  It only observes, runs the EXISTING frozen A-uia entry
# once, then observes again and writes a structured verdict.
#
#   .\run-vd-poc.ps1 -ObserveOnly     # observation layer only, no playback attempt
#   .\run-vd-poc.ps1                  # full PoC (one attempt on the target song)
#   .\run-vd-poc.ps1 -Case C          # pick which known-good song to target
#
# Reuses: poc/lib/am-play.ps1 Invoke-AmPlaySong (unchanged) and the 3.7B audit helpers.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param([string]$Case = 'A', [switch]$ObserveOnly, [int]$PlayWaitMs = 6000)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'lib\vd-common.ps1')
. (Join-Path $root 'poc\lib\am-common.ps1')
. (Join-Path $root 'poc\lib\am-smtc.ps1')
. (Join-Path $root 'poc\lib\am-uia.ps1')
. (Join-Path $root 'poc\lib\am-play.ps1')

function Get-AmPocStamp { return (Get-Date).ToString('yyyyMMdd-HHmmss') }
function Get-AmPocIso { return (Get-Date).ToString('s') }

$rep = Join-Path $PSScriptRoot 'reports'
if (-not (Test-Path $rep)) { New-Item -ItemType Directory -Force -Path $rep | Out-Null }
$stamp = Get-AmPocStamp
$lines = @()

$songs = @((Get-Content (Join-Path $root 'poc\songs.json') -Raw -Encoding UTF8 | ConvertFrom-Json).songs)
$song = @($songs | Where-Object { $_.id -eq $Case })
if ($song.Count -eq 0) { Write-Host ('unknown case: ' + $Case); exit 2 }
$s = $song[0]
$targetTitle = '' + ([string]$s.title)
$targetArtist = '' + ([string]$s.artist)
$targetUrl = ''
foreach ($n in @('verifiedUrl','url','songUrl','canonicalUrl')) { $v = '' + $s.$n; if ($v -ne '') { $targetUrl = $v; break } }

$lines += ('# Virtual desktop isolation PoC  ' + $stamp)
$lines += ('case=' + $Case + ' title=[' + $targetTitle + '] artist=[' + $targetArtist + '] url=' + $targetUrl)
$lines += ('observeOnly=' + ('' + $ObserveOnly).ToLower())
$lines += ''
$lines += '## BEFORE'
$before = Get-AmVdObservation
foreach ($k in $before.Keys) { $lines += ('  ' + $k + '=' + $before[$k]) }
$auditBefore = New-AmNmAudit

$result = [ordered]@{
  case = $Case; title = $targetTitle; artist = $targetArtist; url = $targetUrl; observeOnly = [bool]$ObserveOnly
  stamp = $stamp; ts = (Get-AmPocIso)
  before = $before; after = $null
  attempt = $null
  audits = $null
  verdict = ''; verdictReason = ''; userDesktopDisturbed = $null
}

if (-not $ObserveOnly) {
  $lines += ''
  $lines += '## ATTEMPT (existing frozen A-uia entry, one run, unchanged)'
  # a KNOWN-GOOD target on a DIFFERENT song first is not used: we go straight for the
  # target so SMTC before/after is meaningful.
  $r = Invoke-AmPlaySong -Title $targetTitle -Artist $targetArtist -SongId ('' + $s.id) -Url $targetUrl `
                         -Retries 0 -PauseFirst
  $lines += ('  stage=' + $r.stage + ' ok=' + $r.ok + ' detail=[' + $r.stageDetail + ']')
  $lines += ('  navMethod=' + $r.navMethod + ' navigated=' + $r.navigated + ' contentMatchMs=' + $r.contentMatchMs)
  $lines += ('  matchedRow=' + $r.matchedRow + ' clickRecomputed=' + $r.clickRecomputed)
  $lines += ('  smtcAfter=[title=' + $r.smtc.title + ' artist=' + $r.smtc.artist + ' status=' + $r.smtc.status + ']')
  $result.attempt = [ordered]@{
    ok = [bool]$r.ok; stage = ('' + $r.stage); stageDetail = ('' + $r.stageDetail)
    navMethod = ('' + $r.navMethod); navigated = $r.navigated; contentMatchMs = $r.contentMatchMs
    matchedRow = ('' + $r.matchedRow); clickRecomputed = $r.clickRecomputed
    smtcTitle = ('' + $r.smtc.title); smtcArtist = ('' + $r.smtc.artist); smtcStatus = ('' + $r.smtc.status)
    timings = $r.t; actions = $r.a
  }
  # a bounded extra wait so SMTC can settle before the AFTER observation
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $PlayWaitMs) {
    Start-Sleep -Milliseconds 400
    $smtcMid = Get-AmNavSmtcSnapshot
    if (('' + $smtcMid.status) -eq 'Playing') { break }
  }
}

$lines += ''
$lines += '## AFTER'
$after = Get-AmVdObservation
foreach ($k in $after.Keys) { $lines += ('  ' + $k + '=' + $after[$k]) }
$auditAfter = New-AmNmAudit
$cmp = Compare-AmNmAudit $auditBefore $auditAfter
$result.after = $after
$result.audits = $cmp
$lines += ''
$lines += '## AUDIT (mouse / foreground / focus)'
foreach ($k in $cmp.Keys) { $lines += ('  ' + $k + '=' + $cmp[$k]) }

# ---- verdict -----------------------------------------------------------------
$desktopStable = $true
if (($before['activeDesktopIdProxy'] -ne 'unavailable') -and ($after['activeDesktopIdProxy'] -ne 'unavailable')) {
  $desktopStable = ([string]$before['activeDesktopIdProxy'] -eq [string]$after['activeDesktopIdProxy'])
}
$amStayed = $true
if (($before['appleMusicDesktopId'] -ne 'unavailable') -and ($after['appleMusicDesktopId'] -ne 'unavailable')) {
  $amStayed = ([string]$before['appleMusicDesktopId'] -eq [string]$after['appleMusicDesktopId'])
}
$targetPlaying = ($after['smtcTitle'] -ne '' -and ((('' + $after['smtcTitle']).ToLowerInvariant()).Contains($targetTitle.ToLowerInvariant())) -and (('' + $after['smtcStatus']) -eq 'Playing'))

$result['desktopProxyStable'] = $desktopStable
$result['appleMusicDesktopUnchanged'] = $amStayed
$result['targetPlaying'] = $targetPlaying
$result['userDesktopDisturbed'] = (-not $desktopStable)

if ($ObserveOnly) {
  $result['verdict'] = 'OBSERVATION_ONLY'
  $result['verdictReason'] = 'no playback attempt was made; this run only validates the observation layer'
} elseif ($before['appleMusicIsOnCurrentDesktop'] -eq $true) {
  $result['verdict'] = 'INCONCLUSIVE'
  $result['verdictReason'] = 'Apple Music was already on the CURRENT desktop, so isolation was not under test'
} elseif (-not $desktopStable) {
  $result['verdict'] = 'FAIL'
  $result['verdictReason'] = 'the active desktop changed during the attempt (desktop switch happened)'
} elseif ($targetPlaying -and $amStayed) {
  $result['verdict'] = 'PASS'
  $result['verdictReason'] = 'desktop proxy stable, Apple Music stayed on its own desktop, target song playing per SMTC'
} elseif ($targetPlaying -and -not $amStayed) {
  $result['verdict'] = 'INCONCLUSIVE'
  $result['verdictReason'] = 'target played but Apple Music desktop id changed - investigate what moved it'
} else {
  $result['verdict'] = 'FAIL'
  $result['verdictReason'] = 'desktop stable but SMTC did not reach the target song (check UIA visibility vs input injection separately)'
}
$lines += ''
$lines += '## VERDICT'
$lines += ('  desktopProxyStable=' + $desktopStable + ' appleMusicDesktopUnchanged=' + $amStayed + ' targetPlaying=' + $targetPlaying)
$lines += ('  RESULT: ' + $result['verdict'] + '  (' + $result['verdictReason'] + ')')

$txt = Join-Path $rep ('vd-poc-' + $stamp + '.txt')
$json = Join-Path $rep ('vd-poc-' + $stamp + '.json')
[System.IO.File]::WriteAllText($txt, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($json, ($result | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
$lines | ForEach-Object { Write-Host $_ }
Write-Host ''
Write-Host ('report: ' + $txt)
Write-Host ('json  : ' + $json)
