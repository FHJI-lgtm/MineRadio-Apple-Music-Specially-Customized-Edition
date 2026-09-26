# ============================================================
# phase3.7E-benchmark/probe-w3-programmatic-transition.ps1
# G1b: ONE programmatic transition, observed read-only.
#
# AUTHORISED ACTION (exactly once, no loop):
#     if IsIconic($Hwnd) -> ShowWindow($Hwnd, SW_RESTORE=9)
#     SetForegroundWindow($Hwnd)
#   This mirrors the frozen chain's Invoke-AmForeground order.
#
# PROHIBITED AND ABSENT FROM THIS FILE (static self-scan below proves it):
#   mouse, keyboard, wheel, UIA Invoke/Click, SetCursorPos, SendInput, SendKeys,
#   and any click on an Apple Music control.
#
# PURPOSE: confirm whether the PROGRAMMATIC activation also satisfies the S1 object
# semantics established by G1 (foreground HWND == 196682). It is NOT a W3 performance test.
# Nothing here measures or deletes the 350 ms wait.
#
# NOTE: the shared lib (lib/w3probe.ps1) stays pure read-only and keeps its own 0-site scan;
# only this file declares the two activation entry points.
# ============================================================

param(
  [int]$BaselineMs = 3000,
  [int]$AfterMs = 8000,
  [int]$PollMs = 10,
  [string]$Tag = ''
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\w3probe.ps1')

if (-not ('AmW3Act.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AmW3Act {
  public static class Native {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  }
}
'@
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $Tag) { $Tag = $stamp }
$outDir = Join-Path $PSScriptRoot 'reports'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$jsonl = Join-Path $outDir ("w3prog-$Tag.jsonl")
$sumTxt = Join-Path $outDir ("w3prog-$Tag-summary.txt")

# ---- G0-style static self-scan, SCOPED for this file:
#      forbidden call sites must be 0; allowed activation call sites must each be exactly 1.
# ---- G0-style static self-scan, SCOPED for this file.
# REVISION NOTE: the first version of this block was DEFECTIVE and its printed counts were NOT
# evidence. (a) It counted the prose in the header comment that names the prohibited APIs, which
# produced three false positives (SetCursorPos / SendInput / SendKeys = 1). (b) It built the allowed
# call patterns by array concatenation ('Show','Window') + '(' - PowerShell joins that array with a
# space, so both allowed counts came out 0 (false negatives). This revision scans CODE LINES ONLY
# (a line whose trimmed start is '#' is skipped) and builds every pattern with explicit string
# concatenation. The transition itself was performed once and is unaffected by this fix.
function Get-AmW3CodeText([string]$path) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($l in [System.IO.File]::ReadAllLines($path)) {
    if ($l.TrimStart().StartsWith('#')) { continue }
    [void]$sb.AppendLine($l)
  }
  return $sb.ToString()
}
$selfPath = (Resolve-Path $PSScriptRoot).Path + '\probe-w3-programmatic-transition.ps1'
$selfCode = Get-AmW3CodeText $selfPath
$libCode = Get-AmW3CodeText (Join-Path $PSScriptRoot 'lib\w3probe.ps1')
$frags = @(@('Set', 'CursorPos'), @('mouse_', 'event'), @('Send', 'Input'), @('Send', 'Keys'),
            @('Cursor.', 'Position'), @('Move', 'To('), @('BringWindow', 'ToTop'))
$patSw = ('Show' + 'Window' + '(')
$patSf = ('SetFore' + 'groundWindow' + '(')
$scan = @()
foreach ($fr in $frags) {
  $pat = ($fr -join '')
  $scan += ("forbidden '" + $pat + "' in probe code = " + ([regex]::Matches($selfCode, [regex]::Escape($pat))).Count + " (expect 0)")
}
$scan += ("allowed '" + $patSw + "' in probe code = " + ([regex]::Matches($selfCode, [regex]::Escape($patSw))).Count + " (expect 2 = 1 P/Invoke declaration + 1 call site)")
$scan += ("allowed '" + $patSf + "' in probe code = " + ([regex]::Matches($selfCode, [regex]::Escape($patSf))).Count + " (expect 2 = 1 P/Invoke declaration + 1 call site)")
foreach ($fr in $frags) {
  $pat = ($fr -join '')
  $scan += ("forbidden '" + $pat + "' in shared lib code = " + ([regex]::Matches($libCode, [regex]::Escape($pat))).Count + " (expect 0)")
}
$scan += ("activation APIs in shared lib code = " + (([regex]::Matches($libCode, [regex]::Escape($patSw))).Count + ([regex]::Matches($libCode, [regex]::Escape($patSf))).Count) + " (expect 0)")

$list = Get-AmW3AmWindowList
$primary = Get-AmW3PrimaryAmWindow $list
if (-not $primary) { "ASSERT_FAIL: no Apple Music window found"; exit 9 }
$amH = [int64]$primary.hwnd
$amRoot = [int64]$primary.root
$amPtr = [IntPtr]$amH

$lines = @()
$lines += '=== W3 G1b PROGRAMMATIC TRANSITION PROBE (one transition, read-only observation) ==='
$lines += "tag=$Tag baselineMs=$BaselineMs afterMs=$AfterMs requestedPollMs=$PollMs"
$lines += "jsonl=$jsonl"
$lines += "appleMusicHwnd=$amH appleMusicRootHwnd=$amRoot title=$($primary.title) class=$($primary.cls)"
$lines += "topLevelWindowCount=$($list.count)"
foreach ($s in $scan) { $lines += ('  scan: ' + $s) }

$writer = New-Object System.IO.StreamWriter($jsonl, $false, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $false
$sw = New-Object System.Diagnostics.Stopwatch
$sw.Start()

$samples = 0
$nullSamples = 0
$directSamples = 0
$desktop = 'unavailable'
$lastDeskMs = -100000
$gaps = New-Object System.Collections.ArrayList
$prevAt = $null

# ---- phase 1: baseline (no action at all)
while ($sw.ElapsedMilliseconds -lt $BaselineMs) {
  $at = [int]$sw.ElapsedMilliseconds
  if ($null -ne $prevAt) { [void]$gaps.Add($at - $prevAt) }
  $prevAt = $at
  $fg = [AmW3.Native]::GetForegroundWindow()
  $fgH = [int64]$fg
  $fgRoot = [int64][AmW3.Native]::Root($fg)
  if (($at - $lastDeskMs) -ge 100) { if ($fg -ne [IntPtr]::Zero) { $desktop = [AmW3.Native]::VdGetDesktopId($fg) }; $lastDeskMs = $at }
  $fgPid = 0
  if ($fg -ne [IntPtr]::Zero) { [void][AmW3.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid) }
  $isNull = ($fgH -eq 0)
  $direct = ((-not $isNull) -and ($fgH -eq $amH))
  $fgIsAm = $false
  foreach ($w in $list.windows) { if ($w.pid -eq [int]$fgPid -and $fgPid -ne 0) { $fgIsAm = $true; break } }
  $tgtIconic = [AmW3.Native]::IsIconic($amPtr)
  if ($isNull) { $nullSamples++ }
  if ($direct) { $directSamples++ }
  $row = '{"runId":"' + $Tag + '","phase":"pre","tMs":' + $at + ',"appleMusicHwnd":' + $amH +
         ',"foregroundHwnd":' + $fgH + ',"directEqual":' + $direct.ToString().ToLower() +
         ',"foregroundIsNull":' + $isNull.ToString().ToLower() + ',"foregroundPid":' + $fgPid +
         ',"foregroundIsAmProcess":' + $fgIsAm.ToString().ToLower() + ',"targetIconic":' + $tgtIconic.ToString().ToLower() +
         ',"activeDesktop":"' + $desktop + '"}'
  $writer.WriteLine($row); $samples++
  if (($samples % 200) -eq 0) { $writer.Flush() }
  Start-Sleep -Milliseconds $PollMs
}

# ---- phase 2: THE single programmatic transition (no loop, no retry)
$fgBefore = [int64][AmW3.Native]::GetForegroundWindow()
$wasIconic = [AmW3.Native]::IsIconic($amPtr)
$showWindowCalled = $false
$showWindowResult = $false
if ($wasIconic) { $showWindowResult = [AmW3Act.Native]::ShowWindow($amPtr, 9); $showWindowCalled = $true }
$t0 = [int]$sw.ElapsedMilliseconds
$setFgResult = [AmW3Act.Native]::SetForegroundWindow($amPtr)
$t1 = [int]$sw.ElapsedMilliseconds
$lines += "transition: foregroundBefore=$fgBefore wasIconic=$wasIconic showWindowCalled=$($showWindowCalled.ToString().ToLower()) showWindowResult=$($showWindowResult.ToString().ToLower())"
$lines += "transition: SetForegroundWindow returned $($setFgResult.ToString().ToLower()) (t0=$t0 t1=$t1 callMs=$($t1 - $t0))"

# ---- phase 3: after (no action at all)
$endMs = $t1 + $AfterMs
$firstDirectAfterT0 = -1
$firstNullAfterT0 = -1
$iconicAtFirstDirect = $null
while ($sw.ElapsedMilliseconds -lt $endMs) {
  $at = [int]$sw.ElapsedMilliseconds
  if ($null -ne $prevAt) { [void]$gaps.Add($at - $prevAt) }
  $prevAt = $at
  $fg = [AmW3.Native]::GetForegroundWindow()
  $fgH = [int64]$fg
  $fgRoot = [int64][AmW3.Native]::Root($fg)
  if (($at - $lastDeskMs) -ge 100) { if ($fg -ne [IntPtr]::Zero) { $desktop = [AmW3.Native]::VdGetDesktopId($fg) }; $lastDeskMs = $at }
  $fgPid = 0
  if ($fg -ne [IntPtr]::Zero) { [void][AmW3.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid) }
  $isNull = ($fgH -eq 0)
  $direct = ((-not $isNull) -and ($fgH -eq $amH))
  $fgIsAm = $false
  foreach ($w in $list.windows) { if ($w.pid -eq [int]$fgPid -and $fgPid -ne 0) { $fgIsAm = $true; break } }
  $tgtIconic = [AmW3.Native]::IsIconic($amPtr)
  if ($isNull) { $nullSamples++ }
  if ($direct) { $directSamples++ }
  if ($direct -and $firstDirectAfterT0 -lt 0) { $firstDirectAfterT0 = $at; $iconicAtFirstDirect = $tgtIconic }
  if ($isNull -and $firstNullAfterT0 -lt 0 -and $at -ge $t0) { $firstNullAfterT0 = $at }
  $row = '{"runId":"' + $Tag + '","phase":"post","tMs":' + $at + ',"appleMusicHwnd":' + $amH +
         ',"foregroundHwnd":' + $fgH + ',"directEqual":' + $direct.ToString().ToLower() +
         ',"foregroundIsNull":' + $isNull.ToString().ToLower() + ',"foregroundPid":' + $fgPid +
         ',"foregroundIsAmProcess":' + $fgIsAm.ToString().ToLower() + ',"targetIconic":' + $tgtIconic.ToString().ToLower() +
         ',"activeDesktop":"' + $desktop + '"}'
  $writer.WriteLine($row); $samples++
  if (($samples % 200) -eq 0) { $writer.Flush() }
  Start-Sleep -Milliseconds $PollMs
}
$writer.Flush(); $writer.Close()

$g = @($gaps.ToArray() | Sort-Object)
$gMed = 0; $gMean = 0; $gMax = 0
if ($g.Count -gt 0) {
  $gMed = $g[[int][math]::Floor(($g.Count - 1) / 2)]
  $gMean = [int](($g | Measure-Object -Average).Average)
  $gMax = $g[-1]
}
$lines += "samples=$samples measuredSampleGapMs: n=$($g.Count) median=$gMed mean=$gMean max=$gMax"
$lines += "directEqualSamples=$directSamples nullForegroundSamples=$nullSamples"
if ($firstDirectAfterT0 -ge 0) {
  $lines += "S1_FIRST_SATISFIED_AFTER_TRANSITION: tMs=$firstDirectAfterT0 (t0+$($firstDirectAfterT0 - $t0) ms) targetIconicAtThatInstant=$($iconicAtFirstDirect.ToString().ToLower())"
} else {
  $lines += 'S1_NEVER_SATISFIED_AFTER_TRANSITION: the programmatic call did not make 196682 the foreground within the observed window'
}
if ($firstNullAfterT0 -ge 0) { $lines += "nullForegroundAfterTransition: first at tMs=$firstNullAfterT0" } else { $lines += 'nullForegroundAfterTransition: none' }
$lines += "finalForegroundHwnd=" + [int64][AmW3.Native]::GetForegroundWindow()

foreach ($l in $lines) { $l }
[System.IO.File]::WriteAllText($sumTxt, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
"SUMMARY_FILE: $sumTxt"
