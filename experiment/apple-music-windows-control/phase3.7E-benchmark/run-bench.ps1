# ============================================================
# phase3.7E-benchmark/run-bench.ps1     (rev 2 - A/B/C/D fixes)
#
# Foreground-occupancy benchmark for the existing A-uia chain.
#
# Modes:
#   .\run-bench.ps1 -EmptyBaseline [-Seconds 30]   # sampler only, measures resolution
#   .\run-bench.ps1 -Case B01 [-NoWait]            # one song, one attempt
#   .\run-bench.ps1 -All                           # all pinned songs, one attempt each,
#                                                  # with a MANUAL foreground restore gate
#                                                  # between runs (press ENTER to continue)
#
# rev 2 changes (harness only - the frozen chain, fixture, resolver and SMTC logic are
# untouched, and the B02/B04/B13 chain failures are deliberately NOT fixed here):
#   A  hard gates.  Before a run: Apple Music must be found, not minimized, NOT foreground
#      and on the current desktop, else the run is recorded INVALID_PRECONDITION and the
#      whole benchmark HALTS.  After a run: if the original foreground window was not
#      restored, the run is recorded INVALID_RESTORE and the benchmark HALTS.
#      Because Windows refuses SetForegroundWindow from a background process, the operator
#      restores the foreground by hand and confirms before the next case (no
#      AttachThreadInput / AllowSetForegroundWindow / LockSetForegroundWindow anywhere).
#   B  T3 only counts samples at or after T0, so T3 can no longer be negative; T6 is taken
#      only from samples after T3, and if T6 <= T3 it is set to null (never fabricated).
#   C  activation_to_click_upper_bound_ms / foreground_occupancy_ms are null unless
#      genuinely derivable; the invalid '-else' token is gone and every field is emitted.
#   D  summary at the end: correctness counts, failure stages, and occupancy
#      median/P90/min/max over VALID runs only, with the measured resolution printed.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [switch]$Observer, [string]$Out = '', [int]$PollMs = 50, [int]$Seconds = 30,
  [string]$Case = '', [switch]$All, [switch]$EmptyBaseline, [switch]$NoWait
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$here = $PSScriptRoot
$root = Split-Path $here -Parent

# measured on 20260926-084630 by the empty-poll baseline of this same harness
$script:ResolutionNote = 'resolution: requested 50ms poll -> measured gap median 80ms / mean 82ms / max 121ms (empty baseline 20260926-084630, 255 samples)'

# ---------------------------------------------------------------- observer role
if ($Observer) {
  . (Join-Path $here 'lib\bench-common.ps1')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $lines = New-Object System.Collections.Generic.List[string]
  while ($true) {
    $s = Get-AmBenchSample
    $lines.Add(('{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}' -f `
      [int]$sw.ElapsedMilliseconds, (Get-Date).Ticks, $s.amFound, $s.amHwnd, $s.fgHwnd, `
      $s.amIsForeground, $s.cursorX, $s.cursorY, (($s.smtcTitle + '~' + $s.smtcStatus) -replace '\|', '/')))
    if ($lines.Count % 10 -eq 0) { [System.IO.File]::WriteAllLines($Out, $lines.ToArray()) }
    if (Test-Path ($Out + '.stop')) { break }
    Start-Sleep -Milliseconds $PollMs
  }
  [System.IO.File]::WriteAllLines($Out, $lines.ToArray())
  exit 0
}

# ---------------------------------------------------------------- orchestrator
. (Join-Path $here 'lib\bench-common.ps1')
. (Join-Path $root 'poc\lib\am-common.ps1')
. (Join-Path $root 'poc\lib\am-smtc.ps1')
. (Join-Path $root 'poc\lib\am-uia.ps1')
. (Join-Path $root 'poc\lib\am-play.ps1')

$rep = Join-Path $here 'reports'
if (-not (Test-Path $rep)) { New-Item -ItemType Directory -Force -Path $rep | Out-Null }
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')

function Start-AmBenchObserver([string]$outFile) {
  if (Test-Path ($outFile + '.stop')) { Remove-Item ($outFile + '.stop') -Force }
  Remove-Item $outFile -Force -ErrorAction SilentlyContinue
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File', $PSCommandPath, '-Observer','-Out', $outFile, '-PollMs', $PollMs)
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $a -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 200; $i++) { Start-Sleep -Milliseconds 50; if (Test-Path $outFile) { break } }
  return $p
}
function Stop-AmBenchObserver($proc, [string]$outFile) {
  [System.IO.File]::WriteAllText(($outFile + '.stop'), 'stop')
  Start-Sleep -Milliseconds 400
  if ($proc -and -not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit(3000) | Out-Null }
  Remove-Item ($outFile + '.stop') -Force -ErrorAction SilentlyContinue
}
function Read-AmBenchSamples([string]$outFile) {
  if (-not (Test-Path $outFile)) { return @() }
  $rows = @()
  foreach ($l in (Get-Content $outFile -Encoding UTF8)) {
    if ($l.Trim() -eq '') { continue }
    $p = $l.Split('|')
    if ($p.Count -lt 9) { continue }
    $rows += , @{ t = [int]$p[0]; ticks = [int64]$p[1]; amFound = ($p[2] -eq 'True'); amHwnd = [int64]$p[3]; fgHwnd = [int64]$p[4]
                  amIsForeground = ($p[5] -eq 'True'); x = [int]$p[6]; y = [int]$p[7]; smtc = $p[8] }
  }
  return $rows
}

# ---- environment snapshot (must stay constant for the whole benchmark) --------
$env0 = Get-AmBenchEnv
Write-Host ('env: build=' + $env0.windowsBuild + ' amVersion=' + $env0.appleMusicVersion + ' monitors=' + $env0.monitorCount)
foreach ($k in $env0.Keys) { Write-Host ('  ' + $k + '=' + $env0[$k]) }
Write-Host ('  ' + $script:ResolutionNote)

# ================================================================ empty baseline
if ($EmptyBaseline) {
  $samples = Join-Path $rep ('empty-' + $stamp + '.samples')
  $p = Start-AmBenchObserver $samples
  Start-Sleep -Seconds $Seconds
  Stop-AmBenchObserver $p $samples
  $rows = Read-AmBenchSamples $samples
  $gaps = @()
  for ($i = 1; $i -lt $rows.Count; $i++) { $gaps += ($rows[$i].t - $rows[$i - 1].t) }
  $g = @($gaps | Sort-Object)
  $mean = 0; foreach ($x in $g) { $mean += $x }
  if ($g.Count -gt 0) { $mean = [int]($mean / $g.Count) }
  $med = 0; if ($g.Count -gt 0) { $med = $g[[int][Math]::Floor(($g.Count - 1) / 2)] }
  $mx = 0; if ($g.Count -gt 0) { $mx = $g[$g.Count - 1] }
  Write-Host ''
  Write-Host ('samples=' + $rows.Count + ' gapMean=' + $mean + 'ms gapMedian=' + $med + 'ms gapMax=' + $mx + 'ms')
  $txt = Join-Path $rep ('empty-baseline-' + $stamp + '.txt')
  [System.IO.File]::WriteAllText($txt, (('samples=' + $rows.Count + "`r`n" + 'gapMeanMs=' + $mean + "`r`n" + 'gapMedianMs=' + $med + "`r`n" + 'gapMaxMs=' + $mx + "`r`n" + $script:ResolutionNote)), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ('report: ' + $txt)
  exit 0
}

# ================================================================ case runs
$pinned = @((Get-Content (Join-Path $here 'cases\songs-20-pinned.json') -Raw -Encoding UTF8 | ConvertFrom-Json).cases)
$todo = @()
if ($Case -ne '') { $todo = @($pinned | Where-Object { $_.id -eq $Case }) } elseif ($All) { $todo = @($pinned) }
else { Write-Host 'nothing to do: pass -EmptyBaseline, -Case <id> or -All'; exit 2 }
if ($todo.Count -eq 0) { Write-Host 'no matching pinned case'; exit 2 }

$jsonl = Join-Path $rep ('bench-' + $stamp + '.jsonl')
$runNo = 0
$halt = $false
foreach ($c in $todo) {
  if ($halt) { break }
  $runNo++
  Write-Host ''
  Write-Host ('== [' + $runNo + '/' + $todo.Count + '] ' + $c.id + ' :: ' + $c.title + ' / ' + $c.artist + ' :: id=' + $c.songId)

  # ---- GATE 1 (pre-run precondition; hard) ----
  $pre = Get-AmBenchEnv
  $g1 = @()
  if (-not (Test-Path variable:amPre)) { }
  if (([int64]$pre.appleMusicHwnd) -eq 0) { $g1 += 'AM window not found' }
  if ($pre.appleMusicIsOnCurrentDesktop -ne $true) { $g1 += 'AM not on current desktop' }
  $amfg = ((Get-AmBenchSample).amIsForeground)
  if ($amfg -eq $true) { $g1 += 'AM is ALREADY foreground' }
  if ($g1.Count -gt 0) {
    foreach ($x in $g1) { Write-Host ('   INVALID_PRECONDITION: ' + $x) }
    $rec = [ordered]@{ case = $c.id; run = $runNo; stamp = $stamp; song = $c.title; artist = $c.artist; songId = $c.songId; url = $c.canonicalUrl
                       result = 'INVALID_PRECONDITION'; invalidReason = ($g1 -join '; ')
                       envBefore = $pre; t3_ms = $null; t6_ms = $null; t_smtc_ms = $null; t10_ms = $null; t11_ms = $null
                       activation_to_click_upper_bound_ms = $null; foreground_occupancy_ms = $null; total_ms = $null; resolution = $script:ResolutionNote }
    Add-Content -Path $jsonl -Value ($rec | ConvertTo-Json -Depth 6 -Compress) -Encoding UTF8
    Write-Host '   HALT: precondition gate failed; this run is INVALID and the benchmark stops here.'
    $halt = $true
    break
  }
  Write-Host ('   gate1 ok: AM not foreground, on current desktop, hwnd=' + $pre.appleMusicHwnd + ' fg=' + $pre.originalForegroundHwnd + ' (' + $pre.originalForegroundProcess + ')')

  $samples = Join-Path $rep ($c.id + '-' + $stamp + '.samples')
  $obs = Start-AmBenchObserver $samples
  Start-Sleep -Milliseconds 300
  $t0 = Get-Date
  $r = Invoke-AmPlaySong -Title ('' + $c.title) -Artist ('' + $c.artist) -SongId ('' + $c.songId) -Url ('' + $c.canonicalUrl) -Retries 0 -PauseFirst
  $tCallEnd = Get-Date
  $restoredFg = Invoke-AmBenchRestoreForeground $env0.originalForegroundHwnd
  $t10 = Get-Date
  $restoredCur = Invoke-AmBenchRestoreCursor $env0.cursorX $env0.cursorY
  $t11 = Get-Date
  Start-Sleep -Milliseconds 200
  Stop-AmBenchObserver $obs $samples
  $rows = Read-AmBenchSamples $samples

  # ---- derive T3 (only samples at/after T0) and T6 (only samples at/after T3) ----
  $base = $t0.Ticks
  $rel = { param($ticks) [int]((($ticks - $base) / 10000)) }
  $t3 = $null
  foreach ($s in $rows) { if ((& $rel $s.ticks) -ge 0 -and $s.amIsForeground) { $t3 = $s; break } }
  $t3ms = $null; if ($t3) { $t3ms = & $rel $t3.ticks }
  $t6 = $null
  if ($t3) {
    $prev = $null
    foreach ($s in $rows) {
      $st = & $rel $s.ticks
      if ($st -lt $t3ms) { $prev = $s; continue }
      if ($prev -ne $null -and $prev.x -eq $s.x -and $prev.y -eq $s.y -and ($s.x -ne $env0.cursorX -or $s.y -ne $env0.cursorY)) { $t6 = $prev; break }
      $prev = $s
    }
  }
  $t6ms = $null; if ($t6) { $t6ms = & $rel $t6.ticks }
  if ($t6ms -ne $null -and $t3ms -ne $null -and $t6ms -le $t3ms) { $t6ms = $null }
  $smtcHit = $null
  foreach ($s in $rows) { if ($s.smtc -like ('*' + $c.title + '*Playing*')) { $smtcHit = $s; break } }
  $smtcMs = $null; if ($smtcHit) { $smtcMs = & $rel $smtcHit.ticks }
  $t10ms = & $rel $t10.Ticks
  $ub = $null
  if ($t6ms -ne $null -and $t3ms -ne $null) { $ub = $t6ms - $t3ms }
  $occ = $null
  if ($t3ms -ne $null) { $occ = $t10ms - $t3ms }

  # ---- GATE 2 (post-run restore; hard) ----
  $result = 'OK'
  if ($restoredFg -ne 'ok') { $result = 'INVALID_RESTORE' }

  $rec = [ordered]@{
    case = $c.id; run = $runNo; stamp = $stamp; song = $c.title; artist = $c.artist; songId = $c.songId; url = $c.canonicalUrl
    result = $result; invalidReason = $(if ($result -eq 'INVALID_RESTORE') { ('restoreForeground=' + $restoredFg) } else { '' })
    ok = [bool]$r.ok; stage = ('' + $r.stage); stageDetail = ('' + $r.stageDetail)
    navMethod = ('' + $r.navMethod); navigated = $r.navigated; contentMatchMs = $r.contentMatchMs
    matchedRow = ('' + $r.matchedRow); clickRecomputed = $r.clickRecomputed
    smtcTitle = ('' + $r.smtc.title); smtcArtist = ('' + $r.smtc.artist); smtcStatus = ('' + $r.smtc.status)
    internal = $r.t; actions = $r.a
    t3_ms = $t3ms; t6_ms = $t6ms; t_smtc_ms = $smtcMs; t_callend_ms = (& $rel $tCallEnd.Ticks); t10_ms = $t10ms; t11_ms = (& $rel $t11.Ticks)
    activation_to_click_upper_bound_ms = $ub
    foreground_occupancy_ms = $occ
    total_ms = $t10ms
    restoreForeground = $restoredFg; restoreCursor = $restoredCur
    targetPlaying = (('' + $r.smtc.status) -eq 'Playing' -and (('' + $r.smtc.title).ToLowerInvariant()).Contains($c.title.ToLowerInvariant()))
    samples = $rows.Count; resolution = $script:ResolutionNote; ts = (Get-Date).ToString('s')
  }
  Add-Content -Path $jsonl -Value ($rec | ConvertTo-Json -Depth 6 -Compress) -Encoding UTF8
  Write-Host ('   stage=' + $rec.stage + ' result=' + $result + ' t3=' + $t3ms + 'ms t6=' + $t6ms + 'ms smtc=' + $smtcMs + 'ms t10=' + $t10ms + 'ms occ=' + $occ + 'ms ub=' + $ub + 'ms playing=' + $rec.targetPlaying)
  Write-Host ('   restoreForeground=' + $restoredFg + ' restoreCursor=' + $restoredCur)
  if ($result -eq 'INVALID_RESTORE') {
    Write-Host '   HALT: the original foreground window was not restored, so the next run would not be an independent sample.'
    $halt = $true
    break
  }
  if ($runNo -lt $todo.Count -and -not $NoWait) {
    Write-Host ''
    Write-Host '   >>> MANUAL STEP: switch the foreground back to your own window (Edge), keep Apple Music'
    Write-Host '       non-minimized and NON-foreground, then press ENTER to continue. (No AttachThreadInput /'
    Write-Host '       AllowSetForegroundWindow / LockSetForegroundWindow is used anywhere.)'
    [void](Read-Host)
  }
  if ($runNo -lt $todo.Count) { Start-Sleep -Milliseconds 400 }
}

# ---- summary -----------------------------------------------------------------
$rows = @()
if (Test-Path $jsonl) { $rows = @(Get-Content $jsonl -Encoding UTF8 | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_ | ConvertFrom-Json }) }
$valid = @($rows | Where-Object { $_.result -eq 'OK' -and $_.t3_ms -ne $null })
$play = @($rows | Where-Object { $_.targetPlaying -eq $true })
$stages = @($rows | Where-Object { $_.stage -ne 'OK' } | ForEach-Object { $_.stage } | Group-Object | ForEach-Object { $_.Name + '=' + $_.Count })
Write-Host ''
Write-Host '===== SUMMARY ====='
Write-Host ('runs=' + $rows.Count + ' playingCorrect=' + $play.Count + '/' + $rows.Count + ' timingValid=' + $valid.Count)
if ($stages.Count -gt 0) { Write-Host ('failureStages: ' + ($stages -join ', ')) }
$occ = @($valid | ForEach-Object { [int]$_.foreground_occupancy_ms } | Sort-Object)
if ($occ.Count -gt 0) {
  $sum = 0; foreach ($x in $occ) { $sum += $x }
  $p50 = $occ[[int][Math]::Floor(($occ.Count - 1) * 0.5)]
  $p90 = $occ[[Math]::Min($occ.Count - 1, [int][Math]::Ceiling($occ.Count * 0.9) - 1)]
  Write-Host ('foreground occupancy (valid runs only): n=' + $occ.Count + ' min=' + $occ[0] + 'ms p50=' + $p50 + 'ms p90=' + $p90 + 'ms max=' + $occ[$occ.Count - 1] + 'ms mean=' + [int]($sum / $occ.Count) + 'ms')
} else { Write-Host 'foreground occupancy: no valid samples' }
$ubv = @($valid | Where-Object { $_.activation_to_click_upper_bound_ms -ne $null } | ForEach-Object { [int]$_.activation_to_click_upper_bound_ms })
if ($ubv.Count -gt 0) {
  $s2 = @($ubv | Sort-Object)
  Write-Host ('activation->click upper bound (valid runs): n=' + $s2.Count + ' min=' + $s2[0] + 'ms p50=' + $s2[[int][Math]::Floor(($s2.Count - 1) * 0.5)] + 'ms max=' + $s2[$s2.Count - 1] + 'ms')
}
Write-Host $script:ResolutionNote
Write-Host ('jsonl: ' + $jsonl)
