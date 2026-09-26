# ============================================================
# phase3.7E-benchmark/run-bench.ps1
# Foreground-occupancy benchmark for the existing A-uia chain.
#
# Modes:
#   .\run-bench.ps1 -EmptyBaseline [-Seconds 30]   # sampler only: measures polling
#                                                  # resolution and overhead, no playback
#   .\run-bench.ps1 -Case B01                      # one song, one attempt
#   .\run-bench.ps1 -All                           # all pinned songs, one attempt each
#
# Rules honoured:
#   * Invoke-AmPlaySong (the frozen chain) is CALLED, never modified.
#   * The resolver is OUTSIDE the measured window: the fixture feeds a pinned URL.
#   * One attempt per song, failures are recorded and never overwritten or retried.
#   * T7 (click completion) is NOT observable from outside -> never fabricated;
#     activation_to_click is reported as an UPPER BOUND via T6.
#   * Measurement resolution is declared: poll interval + real sampling overhead.
#   * After each run the original foreground window and cursor are restored.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [switch]$Observer, [string]$Out = '', [int]$PollMs = 50, [int]$Seconds = 30,
  [string]$Case = '', [switch]$All, [switch]$EmptyBaseline
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$here = $PSScriptRoot
$root = Split-Path $here -Parent

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

# ---------------------------------------------------------------- orchestrator role
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
  $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File', $PSCommandPath, '-Observer','-Out', $outFile, '-PollMs', $PollMs)
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -PassThru -WindowStyle Hidden
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

# ---- environment snapshot (recorded once; must stay constant across the 20 runs)
$env0 = Get-AmBenchEnv
Write-Host ('env: build=' + $env0.windowsBuild + ' amVersion=' + $env0.appleMusicVersion + ' monitors=' + $env0.monitorCount)
Write-Host ('env: originalForeground=' + $env0.originalForegroundProcess + ' cursor=' + $env0.cursorX + ',' + $env0.cursorY + ' desktop=' + $env0.activeDesktopIdProxy)
foreach ($k in $env0.Keys) { Write-Host ('  ' + $k + '=' + $env0[$k]) }

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
  $res = [ordered]@{ mode = 'emptyBaseline'; stamp = $stamp; seconds = $Seconds; pollMs = $PollMs
                     samples = $rows.Count; gapMeanMs = $mean; gapMedianMs = $med; gapMinMs = $(if ($g.Count) { $g[0] } else { 0 }); gapMaxMs = $(if ($g.Count) { $g[$g.Count - 1] } else { 0 })
                     declaredResolution = ('poll ' + $PollMs + 'ms + sampling overhead (observed gap median ' + $med + 'ms, max ' + $(if ($g.Count) { $g[$g.Count - 1] } else { 0 }) + 'ms)')
                     env = $env0 }
  $txt = Join-Path $rep ('empty-baseline-' + $stamp + '.txt')
  $lines = @('# Phase 3.7E empty-poll baseline (no playback, no state change)', ('samples=' + $rows.Count), ('gapMeanMs=' + $mean), ('gapMedianMs=' + $med), ('gapMaxMs=' + $(if ($g.Count) { $g[$g.Count - 1] } else { 0 })), ('declaredResolution=' + $res.declaredResolution))
  foreach ($k in $env0.Keys) { $lines += ('env.' + $k + '=' + $env0[$k]) }
  [System.IO.File]::WriteAllText($txt, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ''
  Write-Host ('samples=' + $rows.Count + ' gapMean=' + $mean + 'ms gapMedian=' + $med + 'ms gapMax=' + $(if ($g.Count) { $g[$g.Count - 1] } else { 0 }) + 'ms')
  Write-Host ('RESOLUTION: ' + $res.declaredResolution)
  Write-Host ('report: ' + $txt)
  exit 0
}

# ================================================================ case runs
$pinned = @((Get-Content (Join-Path $here 'cases\songs-20-pinned.json') -Raw -Encoding UTF8 | ConvertFrom-Json).cases)
$todo = @()
if ($Case -ne '') { $todo = @($pinned | Where-Object { $_.id -eq $Case }) }
elseif ($All) { $todo = @($pinned) }
else { Write-Host 'nothing to do: pass -EmptyBaseline, -Case <id> or -All'; exit 2 }
if ($todo.Count -eq 0) { Write-Host 'no matching pinned case'; exit 2 }

$jsonl = Join-Path $rep ('bench-' + $stamp + '.jsonl')
$runNo = 0
foreach ($c in $todo) {
  $runNo++
  Write-Host ('== [' + $runNo + '/' + $todo.Count + '] ' + $c.id + ' :: ' + $c.title + ' / ' + $c.artist + ' :: id=' + $c.songId)
  # per-run environment check (variability must stay zero)
  $pre = Get-AmBenchEnv
  $mix = @()
  foreach ($k in @('originalForegroundHwnd','cursorX','cursorY','activeDesktopIdProxy','appleMusicDesktopId','appleMusicIsOnCurrentDesktop','monitorCount')) {
    if (('' + $pre[$k]) -ne ('' + $env0[$k])) { $mix += ($k + ' ' + $env0[$k] + '->' + $pre[$k]) }
  }
  $samples = Join-Path $rep ($c.id + '-' + $stamp + '.samples')
  $obs = Start-AmBenchObserver $samples
  Start-Sleep -Milliseconds 300
  $t0 = Get-Date
  $r = Invoke-AmPlaySong -Title ('' + $c.title) -Artist ('' + $c.artist) -SongId ('' + $c.songId) -Url ('' + $c.canonicalUrl) -Retries 0 -PauseFirst
  $tCallEnd = Get-Date
  # restore original foreground + cursor (this experiment's own step; T10/T11)
  $restoredFg = Invoke-AmBenchRestoreForeground $env0.originalForegroundHwnd
  $t10 = Get-Date
  $restoredCur = Invoke-AmBenchRestoreCursor $env0.cursorX $env0.cursorY
  $t11 = Get-Date
  Start-Sleep -Milliseconds 200
  Stop-AmBenchObserver $obs $samples
  $rows = Read-AmBenchSamples $samples

  $amHwnd = 0
  foreach ($s in $rows) { if ($s.amHwnd -ne 0) { $amHwnd = $s.amHwnd; break } }
  $t3 = $null; $t6 = $null; $prev = $null
  foreach ($s in $rows) {
    if ($t3 -eq $null -and $s.amIsForeground) { $t3 = $s }
    if ($s.x -ne 0 -and $prev -ne $null -and $prev.x -eq $s.x -and $prev.y -eq $s.y -and ($prev.x -ne $env0.cursorX -or $prev.y -ne $env0.cursorY)) { if ($t6 -eq $null) { $t6 = $prev } }
    $prev = $s
  }
  $smtcHit = $null
  foreach ($s in $rows) { if ($s.smtc -like ('*' + $c.title + '*Playing*')) { $smtcHit = $s; break } }
  $base = $t0.Ticks
  $ms = { param($ticks) if ($ticks -eq $null) { $null } else { [int]((($ticks - $base) / 10000)) } }
  $rec = [ordered]@{
    case = $c.id; run = $runNo; stamp = $stamp; song = $c.title; artist = $c.artist; songId = $c.songId; url = $c.canonicalUrl
    envMismatch = ($mix -join '; ')
    ok = [bool]$r.ok; stage = ('' + $r.stage); stageDetail = ('' + $r.stageDetail)
    navMethod = ('' + $r.navMethod); navigated = $r.navigated; contentMatchMs = $r.contentMatchMs
    matchedRow = ('' + $r.matchedRow); clickRecomputed = $r.clickRecomputed
    smtcTitle = ('' + $r.smtc.title); smtcArtist = ('' + $r.smtc.artist); smtcStatus = ('' + $r.smtc.status)
    internal = $r.t; actions = $r.a
    t1_ms = 0
    t3_ms = (& $ms $(if ($t3) { $t3.ticks } else { $null }))
    t6_ms = (& $ms $(if ($t6) { $t6.ticks } else { $null }))
    t_smtc_ms = (& $ms $(if ($smtcHit) { $smtcHit.ticks } else { $null }))
    t_callend_ms = (& $ms $tCallEnd.Ticks)
    t10_ms = (& $ms $t10.Ticks); t11_ms = (& $ms $t11.Ticks)
    activation_to_click_upper_bound_ms = $(if ($t3 -and $t6) { & $ms $t6.ticks } -else { $null })
    foreground_occupancy_ms = $(if ($t3) { & $ms $t10.Ticks } else { $null })
    total_ms = (& $ms $t10.Ticks)
    restoreForeground = $restoredFg; restoreCursor = $restoredCur
    samples = $rows.Count
    targetPlaying = (('' + $r.smtc.status) -eq 'Playing' -and (('' + $r.smtc.title).ToLowerInvariant()).Contains($c.title.ToLowerInvariant()))
    ts = (Get-Date).ToString('s')
  }
  Add-Content -Path $jsonl -Value ($rec | ConvertTo-Json -Depth 6 -Compress) -Encoding UTF8
  Write-Host ('   stage=' + $rec.stage + ' t3=' + $rec.t3_ms + 'ms t6=' + $rec.t6_ms + 'ms smtc=' + $rec.t_smtc_ms + 'ms t10=' + $rec.t10_ms + 'ms occupancy=' + $rec.foreground_occupancy_ms + 'ms total=' + $rec.total_ms + 'ms playing=' + $rec.targetPlaying)
  if ($mix.Count -gt 0) { Write-Host ('   ENV CHANGED: ' + ($mix -join '; ')) }
  if ($runNo -lt $todo.Count) { Start-Sleep -Milliseconds 800 }
}
Write-Host ''
Write-Host ('jsonl: ' + $jsonl)
