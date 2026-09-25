# ============================================================
# phase3.7D-zorder/run-zorder-poc.ps1
# Z-Order Background Interaction PoC.
#
#   .\run-zorder-poc.ps1 -ObserveOnly      # read-only; no state change at all
#   .\run-zorder-poc.ps1 -Case A           # ONE controlled attempt (run once!)
#
# Case A sequence, strictly:
#   STEP 0  record BEFORE
#   STEP 1  verify: Apple Music on the CURRENT desktop and NOT foreground
#   STEP 2  SetWindowPos(HWND_BOTTOM, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_SHOWWINDOW)
#   STEP 3  observe immediately: did the call itself foreground Apple Music?
#   STEP 4  one short fixed settle wait (no loop)
#   STEP 5  call the EXISTING frozen entry Invoke-AmPlaySong (nothing rewritten)
#   STEP 6  record AFTER and classify
#
# No retry, no second SetWindowPos, no second click, no stress loop.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param([string]$Case = 'A', [switch]$ObserveOnly, [int]$SettleMs = 1200, [int]$PlayWaitMs = 6000)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'lib\zorder-common.ps1')
. (Join-Path $root 'poc\lib\am-common.ps1')
. (Join-Path $root 'poc\lib\am-smtc.ps1')
. (Join-Path $root 'poc\lib\am-uia.ps1')
. (Join-Path $root 'poc\lib\am-play.ps1')

function Get-AmZoStamp { return (Get-Date).ToString('yyyyMMdd-HHmmss') }
function Get-AmZoIso { return (Get-Date).ToString('s') }

$rep = Join-Path $PSScriptRoot 'reports'
if (-not (Test-Path $rep)) { New-Item -ItemType Directory -Force -Path $rep | Out-Null }
$stamp = Get-AmZoStamp
$lines = @()

$songs = @((Get-Content (Join-Path $root 'poc\songs.json') -Raw -Encoding UTF8 | ConvertFrom-Json).songs)
$song = @($songs | Where-Object { $_.id -eq $Case })
if ($song.Count -eq 0) { Write-Host ('unknown case: ' + $Case); exit 2 }
$s = $song[0]
$targetTitle = '' + ([string]$s.title)
$targetArtist = '' + ([string]$s.artist)
$targetUrl = ''
foreach ($n in @('verifiedUrl','url','songUrl','canonicalUrl')) { $v = '' + $s.$n; if ($v -ne '') { $targetUrl = $v; break } }

$lines += ('# Phase 3.7D Z-Order PoC  ' + $stamp)
$lines += ('target=[' + $targetTitle + '] artist=[' + $targetArtist + '] url=' + $targetUrl)

# ---------------- STEP 0 ---------------
$before = Get-AmZoObservation
$lines += ''
$lines += '## BEFORE'
foreach ($k in $before.Keys) { $lines += ('  ' + $k + '=' + $before[$k]) }

$result = [ordered]@{
  case = $Case; timestamp = (Get-AmZoIso); stamp = $stamp
  targetTrack = $targetTitle; targetArtist = $targetArtist
  activeDesktopIdBefore = $before['activeDesktopIdProxy']; activeDesktopIdAfter = $null
  appleMusicDesktopIdBefore = $before['appleMusicDesktopId']; appleMusicDesktopIdAfter = $null
  appleMusicIsOnCurrentDesktopBefore = $before['appleMusicIsOnCurrentDesktop']; appleMusicIsOnCurrentDesktopAfter = $null
  appleMusicWindowHandle = $before['appleMusicWindowHandle']
  foregroundWindowBefore = $before['foregroundWindow']; foregroundWindowAfter = $null
  foregroundProcessBefore = $before['foregroundProcess']; foregroundProcessAfter = $null
  appleMusicIsForegroundBefore = $before['appleMusicIsForeground']; appleMusicIsForegroundAfter = $null
  foregroundChanged = $null; foregroundChangedByApplication = $null
  mouseMoved = $null; mouseXBefore = $before['mouseX']; mouseYBefore = $before['mouseY']
  mouseXAfter = $null; mouseYAfter = $null
  physicalKeyboardInput = $false
  uiaWindowFoundBefore = $before['uiaWindowFound']; uiaWindowFoundAfter = $null
  uiaTargetFound = $null; matchedRow = ''; clickRecomputed = $null
  zOrderOperation = $null; zOrderOperationHr = $null
  zOrderObservationBefore = $before['zOrderObservation']; zOrderObservationAfter = $null
  smtcTitleBefore = $before['smtcTitle']; smtcArtistBefore = $before['smtcArtist']; smtcStatusBefore = $before['smtcStatus']
  smtcTitleAfter = $null; smtcArtistAfter = $null; smtcStatusAfter = $null
  targetPlaying = $false
  result = ''; failureReason = ''
  observeOnly = [bool]$ObserveOnly
}

if ($ObserveOnly) {
  $result['result'] = 'OBSERVE_ONLY'
  $result['failureReason'] = 'no state change was made; observation layer only'
  if (-not $before['appleMusicProcessRunning']) { $result['result'] = 'STOPPED_AT_PRECONDITION'; $result['failureReason'] = 'appleMusicProcessRunning=false' }
  elseif ($before['appleMusicWindowHandle'] -eq 0) { $result['result'] = 'STOPPED_AT_PRECONDITION'; $result['failureReason'] = 'no valid Apple Music hwnd' }
  elseif ($before['smtcTitle'] -eq '') { $result['result'] = 'STOPPED_AT_PRECONDITION'; $result['failureReason'] = 'no SMTC session' }
  $lines += ''
  $lines += ('## RESULT: ' + $result['result'] + '  (' + $result['failureReason'] + ')')
} else {
  # ---------------- STEP 1 ---------------
  $pre1 = @()
  if ($before['appleMusicIsOnCurrentDesktop'] -ne $true) { $pre1 += 'Apple Music is not on the CURRENT desktop' }
  if ($before['appleMusicIsForeground'] -eq $true) { $pre1 += 'Apple Music is already foreground' }
  if ($before['appleMusicWindowHandle'] -eq 0) { $pre1 += 'no hwnd' }
  if ($before['appleMusicIconic'] -eq $true) { $pre1 += 'window is minimized' }
  if ($before['smtcTitle'] -eq '') { $pre1 += 'no SMTC session' }
  $lines += ''
  $lines += '## STEP 1 preconditions'
  if ($pre1.Count -gt 0) {
    foreach ($p in $pre1) { $lines += ('  MISSING: ' + $p) }
    $result['result'] = 'INCONCLUSIVE'
    $result['failureReason'] = ('preconditions not met: ' + ($pre1 -join '; '))
    $lines += ('## RESULT: INCONCLUSIVE  (' + $result['failureReason'] + ')')
  } else {
    $lines += '  ok: on current desktop, not foreground, not minimized, SMTC present'

    # ---------------- STEP 2 ---------------
    $zop = Invoke-AmZoPushToBottom -Hwnd ([IntPtr]$before['appleMusicWindowHandle'])
    $result['zOrderOperation'] = ($zop.flags + ' -> ' + $zop.hwndInsertAfter)
    $result['zOrderOperationHr'] = if ($zop.ok) { 'ok' } else { ('win32Error=' + $zop.win32Error + ' ' + $zop.error) }
    $lines += ''
    $lines += '## STEP 2 Z-order operation'
    foreach ($k in $zop.Keys) { $lines += ('  ' + $k + '=' + $zop[$k]) }

    # ---------------- STEP 3 ---------------
    $postOp = Get-AmZoObservation
    $lines += ''
    $lines += '## STEP 3 immediately after SetWindowPos'
    foreach ($k in @('foregroundProcess','foregroundTitle','appleMusicIsForeground','activeDesktopIdProxy','appleMusicDesktopId','zOrderObservation','smtcTitle','smtcStatus')) {
      $lines += ('  ' + $k + '=' + $postOp[$k])
    }

    # ---------------- STEP 4 ---------------
    Start-Sleep -Milliseconds $SettleMs

    # ---------------- STEP 5 ---------------
    $lines += ''
    $lines += '## STEP 5 existing frozen A-uia entry (one call, unchanged)'
    $r = Invoke-AmPlaySong -Title $targetTitle -Artist $targetArtist -SongId ('' + $s.id) -Url $targetUrl -Retries 0 -PauseFirst
    $lines += ('  stage=' + $r.stage + ' ok=' + $r.ok + ' detail=[' + $r.stageDetail + ']')
    $lines += ('  navMethod=' + $r.navMethod + ' navigated=' + $r.navigated + ' contentMatchMs=' + $r.contentMatchMs)
    $lines += ('  matchedRow=' + $r.matchedRow + ' clickRecomputed=' + $r.clickRecomputed)

    # ---------------- STEP 6 ---------------
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $PlayWaitMs) {
      Start-Sleep -Milliseconds 400
      $mid = Get-AmNavSmtcSnapshot
      if (('' + $mid.status) -eq 'Playing') { break }
    }
    $after = Get-AmZoObservation
    $lines += ''
    $lines += '## AFTER'
    foreach ($k in $after.Keys) { $lines += ('  ' + $k + '=' + $after[$k]) }

    $result['activeDesktopIdAfter'] = $after['activeDesktopIdProxy']
    $result['appleMusicDesktopIdAfter'] = $after['appleMusicDesktopId']
    $result['appleMusicIsOnCurrentDesktopAfter'] = $after['appleMusicIsOnCurrentDesktop']
    $result['foregroundWindowAfter'] = $after['foregroundWindow']
    $result['foregroundProcessAfter'] = $after['foregroundProcess']
    $result['appleMusicIsForegroundAfter'] = $after['appleMusicIsForeground']
    $result['mouseXAfter'] = $after['mouseX']; $result['mouseYAfter'] = $after['mouseY']
    $result['uiaWindowFoundAfter'] = $after['uiaWindowFound']
    $result['zOrderObservationAfter'] = $after['zOrderObservation']
    $result['smtcTitleAfter'] = $after['smtcTitle']
    $result['smtcArtistAfter'] = $after['smtcArtist']
    $result['smtcStatusAfter'] = $after['smtcStatus']
    $result['matchedRow'] = '' + $r.matchedRow
    $result['clickRecomputed'] = $r.clickRecomputed
    $result['uiaTargetFound'] = ($r.matchedRow -ne '' -or ('OK' -eq ('' + $r.stage)))
    $result['mouseMoved'] = (($before['mouseX'] -ne $after['mouseX']) -or ($before['mouseY'] -ne $after['mouseY']))
    $result['foregroundChanged'] = ([int64]$before['foregroundWindow'] -ne [int64]$after['foregroundWindow'])
    $result['foregroundChangedByApplication'] = $false
    $tp = ($after['smtcTitle'] -ne '') -and ((('' + $after['smtcTitle']).ToLowerInvariant()).Contains($targetTitle.ToLowerInvariant())) -and (('' + $after['smtcStatus']) -eq 'Playing')
    $result['targetPlaying'] = $tp

    $desktopSame = ([string]$before['activeDesktopIdProxy'] -eq [string]$after['activeDesktopIdProxy'])
    $amDesktopSame = ([string]$before['appleMusicDesktopId'] -eq [string]$after['appleMusicDesktopId'])
    $amStayedBack = (-not $after['appleMusicIsForeground'])

    if (-not $desktopSame) {
      $result['result'] = 'FAIL_DESKTOP_CHANGED'
      $result['failureReason'] = ('active desktop proxy changed: ' + $before['activeDesktopIdProxy'] + ' -> ' + $after['activeDesktopIdProxy'])
    } elseif ($after['appleMusicIsForeground'] -eq $true) {
      $result['result'] = 'FAIL_ZORDER_REACTIVATED'
      $result['failureReason'] = 'Apple Music became foreground during the attempt (Z-order did not suppress the activation requirement)'
    } elseif (-not $desktopSame -or -not $amDesktopSame) {
      $result['result'] = 'FAIL_FOREGROUND_CHANGED'
      $result['failureReason'] = 'desktop/foreground state changed without Apple Music being the foreground window'
    } elseif ($result['mouseMoved'] -eq $true) {
      $result['result'] = 'FAIL_MOUSE_INJECTION'
      $result['failureReason'] = ('cursor moved ' + $before['mouseX'] + ',' + $before['mouseY'] + ' -> ' + $after['mouseX'] + ',' + $after['mouseY'])
    } elseif ($result['uiaTargetFound'] -ne $true) {
      $result['result'] = 'FAIL_UIA_TARGET'
      $result['failureReason'] = ('UIA could not reach the target while backgrounded (stage=' + $r.stage + ')')
    } elseif (-not $tp) {
      $result['result'] = 'FAIL_PLAYBACK'
      $result['failureReason'] = 'target located and clicked with no foreground change, but SMTC did not switch'
    } elseif ($result['foregroundChanged'] -eq $true) {
      $result['result'] = 'FAIL_FOREGROUND_CHANGED'
      $result['failureReason'] = ('foreground changed ' + $before['foregroundProcess'] + ' -> ' + $after['foregroundProcess'])
    } else {
      $result['result'] = 'PASS'
      $result['failureReason'] = ''
    }
    $lines += ''
    $lines += '## RESULT: ' + $result['result']
    $lines += ('  reason: ' + $result['failureReason'])
  }
}

$txt = Join-Path $rep ('zorder-poc-' + $stamp + '.txt')
$json = Join-Path $rep ('zorder-poc-' + $stamp + '.json')
[System.IO.File]::WriteAllText($txt, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
try { [System.IO.File]::WriteAllText($json, ($result | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false))) } catch { Write-Host ('json write failed: ' + $_.Exception.Message) }
$lines | ForEach-Object { Write-Host $_ }
Write-Host ''
Write-Host ('report: ' + $txt)
Write-Host ('json  : ' + $json)
