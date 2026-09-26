# ============================================================
# phase3.7E-benchmark/probe-w3-foreground.ps1
# G1 read-only probe: WHICH object is the foreground during an Apple Music activation?
#
# PURPOSE (G1)
#   Answer "in this activation path, is $Hwnd the foreground object we want S1 to mean?"
#   It does NOT answer "which comparison (direct == or GA_ROOT) is better" - that decision
#   waits for this data. No condition is loosened here to reduce hypothetical timeouts.
#
# SAFETY
#   * Read-only observer. It never activates Apple Music, never changes Z-order, never calls
#     a UIA pattern, never injects input, never calls SetForegroundWindow/SetWindowPos.
#   * A transition must be produced by a HUMAN (or by a later, separately authorised run).
#     This probe cannot cause one.
#   * HWND == 0 is recorded as foregroundIsNull=true and means "S1 NOT SATISFIED" - Zero is
#     never treated as a wildcard and never falls back to a root comparison.
#
# SAMPLING PARAMETER
#   -PollMs defaults to 10. P=10 ms belongs to THIS PROBE ONLY. It is not a production
#   recommendation and it does not participate in any conclusion about whether W3 can be
#   optimised. The measured sample gap is reported with every run.
# ============================================================

param(
  [int]$Seconds = 60,
  [int]$PollMs = 10,
  [string]$Tag = ''
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\w3probe.ps1')

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $Tag) { $Tag = $stamp }
$outDir = Join-Path $PSScriptRoot 'reports'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$jsonl = Join-Path $outDir ("w3probe-$Tag.jsonl")
$winJson = Join-Path $outDir ("w3probe-$Tag-windows.json")
$sumTxt = Join-Path $outDir ("w3probe-$Tag-summary.txt")

# ---- G0 static self-scan (pattern assembled from fragments so the scan does not match itself)
$frag = @('Set', 'CursorPos|mouse_', 'event|Send', 'Input|Send', 'Keys|SetFore', 'groundWindow|SetWindow', 'Pos|BringWindowToTop|ShowWindow')
$pat = ($frag -join '')
$scanLines = @()
foreach ($f in @((Join-Path $PSScriptRoot 'probe-w3-foreground.ps1'), (Join-Path $PSScriptRoot 'lib\w3probe.ps1'))) {
  $hits = @(Select-String -LiteralPath $f -Pattern $pat | Where-Object { $_.Line -notmatch '^\s*#|static self-scan|injection-API|\$frag' })
  $scanLines += ((Split-Path $f -Leaf) + ': ' + $hits.Count + ' injection-API call sites' + $(if ($hits.Count) { ' -> ' + (($hits | ForEach-Object { $_.LineNumber }) -join ',') } else { '' }))
}

# ---- target enumeration
$list = Get-AmW3AmWindowList
$primary = Get-AmW3PrimaryAmWindow $list
if (-not $primary) {
  "ASSERT_FAIL: no Apple Music top-level window found (error=$($list.error)); G1 cannot run."
  exit 9
}
$amH = [int64]$primary.hwnd
$amRoot = [int64]$primary.root
$snapshots = New-Object System.Collections.ArrayList
[void]$snapshots.Add((Get-AmW3WindowsJson $Tag $list $primary))

$lines = @()
$lines += '=== W3 G1 PROBE (read-only foreground object semantics) ==='
$lines += "tag=$Tag seconds=$Seconds requestedPollMs=$PollMs"
$lines += "jsonl=$jsonl"
$lines += "appleMusicProcessCount=$($list.processCount) topLevelWindowCount=$($list.count) enumError=$($list.error)"
$lines += "primaryHwnd=$amH primaryRoot=$amRoot title=$($primary.title) class=$($primary.cls) visible=$($primary.visible) iconic=$($primary.iconic)"
$lines += 'AM top-level windows:'
foreach ($w in $list.windows) {
  $lines += ("  hwnd=$($w.hwnd) root=$($w.root) pid=$($w.pid) visible=$($w.visible) iconic=$($w.iconic) class=$($w.cls) title=$($w.title)")
}
$lines += ('selection convention: first visible window with a non-empty title, else first enumerated')

# ---- sampling
$sw = New-Object System.Diagnostics.Stopwatch
$writer = New-Object System.IO.StreamWriter($jsonl, $false, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $false
$sw.Start()
$samples = 0
$nullFg = 0
$directSeen = 0
$rootOnlySeen = 0
$amProcessSeen = 0
$desktop = 'unavailable'
$lastDeskMs = -100000
$episodes = New-Object System.Collections.ArrayList
$prevFg = [int64]::MinValue
$ep = $null
$gaps = New-Object System.Collections.ArrayList
$prevAt = $null

while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $at = [int]$sw.ElapsedMilliseconds
  if ($null -ne $prevAt) { [void]$gaps.Add($at - $prevAt) }
  $prevAt = $at

  $fg = [AmW3.Native]::GetForegroundWindow()
  $fgH = [int64]$fg
  $fgRoot = [int64][AmW3.Native]::Root($fg)
  if (($at - $lastDeskMs) -ge 100) {
    if ($fg -ne [IntPtr]::Zero) { $desktop = [AmW3.Native]::VdGetDesktopId($fg) }
    $lastDeskMs = $at
  }
  $fgPid = 0
  if ($fg -ne [IntPtr]::Zero) { [void][AmW3.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid) }
  $isNull = ($fgH -eq 0)
  $direct = ((-not $isNull) -and ($fgH -eq $amH))
  $rootEq = ((-not $isNull) -and ($fgRoot -eq $amRoot))
  $fgIsAm = $false
  foreach ($w in $list.windows) { if ($w.pid -eq [int]$fgPid -and $fgPid -ne 0) { $fgIsAm = $true; break } }
  # Target window state at this instant (read-only user32 queries). Distinguishes an activation
  # that had to restore a minimized window (the SW_RESTORE path) from activation of an
  # already-restored window. Added before the second observation run; declared as a field
  # difference between run 1 and run 2 rather than retro-fitted onto run 1.
  $tgtIconic = [AmW3.Native]::IsIconic([IntPtr]$amH)
  $tgtVisible = [AmW3.Native]::IsWindowVisible([IntPtr]$amH)

  if ($isNull) { $nullFg++ }
  if ($direct) { $directSeen++ }
  if ($rootEq -and -not $direct) { $rootOnlySeen++ }
  if ($fgIsAm) { $amProcessSeen++ }

  $ts = (Get-Date).ToString('HH:mm:ss.fff')
  $row = '{"runId":"' + $Tag + '","tMs":' + $at + ',"timestamp":"' + $ts + '"' +
         ',"appleMusicHwnd":' + $amH + ',"foregroundHwnd":' + $fgH +
         ',"appleMusicRootHwnd":' + $amRoot + ',"foregroundRootHwnd":' + $fgRoot +
         ',"directEqual":' + $direct.ToString().ToLower() +
         ',"rootEqual":' + $rootEq.ToString().ToLower() +
         ',"foregroundIsNull":' + $isNull.ToString().ToLower() +
         ',"foregroundPid":' + $fgPid + ',"foregroundIsAmProcess":' + $fgIsAm.ToString().ToLower() +
         ',"targetIconic":' + $tgtIconic.ToString().ToLower() + ',"targetVisible":' + $tgtVisible.ToString().ToLower() +
         ',"activeDesktop":"' + $desktop + '","desktopAgeMs":' + ($at - $lastDeskMs) + '}'
  $writer.WriteLine($row)
  $samples++
  if (($samples % 200) -eq 0) { $writer.Flush() }

  if ($fgH -ne $prevFg) {
    if ($ep) { $ep['endMs'] = $at; [void]$episodes.Add($ep) }
    $ep = @{ startMs = $at; endMs = $at; hwnd = $fgH; root = $fgRoot; pid = [int]$fgPid; direct = $direct; rootEq = $rootEq; isNull = $isNull; isAmProcess = $fgIsAm }
    $prevFg = $fgH
    if ($snapshots.Count -lt 30) {
      $l2 = Get-AmW3AmWindowList
      [void]$snapshots.Add((Get-AmW3WindowsJson ($Tag + '-at-' + $at) $l2 (Get-AmW3PrimaryAmWindow $l2)))
    }
  }
  Start-Sleep -Milliseconds $PollMs
}
if ($ep) { $ep['endMs'] = [int]$sw.ElapsedMilliseconds; [void]$episodes.Add($ep) }
$writer.Flush(); $writer.Close()

$g = @($gaps.ToArray() | Sort-Object)
$gMed = 0; $gMean = 0; $gMax = 0
if ($g.Count -gt 0) {
  $gMed = $g[[int][math]::Floor(($g.Count - 1) / 2)]
  $gMean = [int](($g | Measure-Object -Average).Average)
  $gMax = $g[-1]
}
$lines += "samples=$samples measuredSampleGapMs: n=$($g.Count) median=$gMed mean=$gMean max=$gMax"
$lines += "nullForegroundSamples=$nullFg directEqualSamples=$directSeen rootEqualOnlySamples=$rootOnlySeen foregroundIsAmProcessSamples=$amProcessSeen"
$lines += 'foreground episodes (start-end ms | hwnd | root | pid | amDirect | amRoot | null | amProcess | duration):'
$n = 0
foreach ($e in $episodes) {
  $n++
  if ($n -gt 40) { $lines += '  ... (truncated)'; break }
  $lines += ("  {0,6}-{1,6} | {2,9} | {3,9} | {4,6} | {5,5} | {6,5} | {7,5} | {8,5} | {9,5}ms" -f $e.startMs, $e.endMs, $e.hwnd, $e.root, $e.pid,
             $e.direct.ToString().ToLower(), $e.rootEq.ToString().ToLower(), $e.isNull.ToString().ToLower(), $e.isAmProcess.ToString().ToLower(), ($e.endMs - $e.startMs))
}
$caseA = ($directSeen -gt 0)
$caseB = ($rootOnlySeen -gt 0)
$lines += "CASE_A_foregroundEqualsTargetHwnd=$($caseA.ToString().ToLower()) CASE_B_rootEqualsButHwndDiffers=$($caseB.ToString().ToLower())"
if (-not $caseA -and -not $caseB) { $lines += 'NEITHER CASE OBSERVED: the target window was never the foreground during this window (no activation happened).' }
$lines += 'static self-scan (0 expected):'
foreach ($s in $scanLines) { $lines += ('  ' + $s) }
$lines += 'NOTE: no injection API was called by this probe; it cannot activate anything. A transition must come from a human action or a separately authorised run.'
$lines += 'NOTE: P=10 ms belongs to this probe only; it is not a production recommendation and does not participate in any W3 optimizability conclusion.'

foreach ($l in $lines) { $l }
[System.IO.File]::WriteAllText($sumTxt, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($winJson, ('{"tag":"' + $Tag + '","snapshots":[' + (@($snapshots.ToArray()) -join ',') + ']}'), (New-Object System.Text.UTF8Encoding($false)))
"SUMMARY_FILE: $sumTxt"
"WINDOWS_FILE: $winJson"
