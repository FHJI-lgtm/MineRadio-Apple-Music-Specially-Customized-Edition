# ============================================================
# phase3.7E-benchmark/g2-negative-path.ps1
# G2: negative-path safety test of the PROPOSED W3 state substitution.
#
# Question G2 answers: when S1 is NOT satisfied within the 350 ms deadline, does the
# control flow absolutely block every downstream step (geometry read, cursor move,
# click, double-click, SMTC verify)?
#
# CONTROLLED TIMEOUT (the whole point):
#   -Mode ForceTimeout   -> the S1 predicate is forced false by an explicit branch.
#                           It does NOT wait hoping SetForegroundWindow fails, and it never
#                           calls any activation API. Only the predicate outcome is controlled;
#                           the 350 ms / 10 ms polling loop itself is the real proposed code.
#   -Mode ForceSatisfied -> the control run: predicate forced true. Proves the gate is the ONLY
#                           thing standing between the wait and the downstream steps (i.e. the
#                           block is not vacuous). Still injects nothing.
#   -Mode Live           -> real predicate (GetForegroundWindow == target). NOT part of G2; reserved.
#
# SAFETY / CAPABILITY
#   This file declares NO injection API and NO activation API - not SetCursorPos, not mouse_event,
#   not SendInput/SendKeys/keybd_event, not ShowWindow, not SetForegroundWindow, not any UIA
#   pattern. The downstream steps are therefore NON-EXECUTING, COUNTED placeholders: they record
#   reachability only. That is deliberate - it makes G2 impossible to turn into a real input test.
#   What G2 proves: (1) control-flow reachability under a controlled timeout, (2) real environment
#   invariance (cursor position, foreground window, system-wide last-input tick, SMTC state).
#   What G2 does NOT prove: that the eventual production edit is safe (that is G3/G4 under a real
#   benchmark with SMTC verification). This limitation is stated in the report as well.
# ============================================================

param(
  [ValidateSet('ForceTimeout', 'ForceSatisfied', 'Live')][string]$Mode = 'ForceTimeout',
  [int]$TimeoutMs = 350,
  [int]$PollMs = 10,
  [string]$Tag = 'g2'
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\w3probe.ps1')

if (-not ('AmG2.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AmG2 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static class Native {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  }
}
'@
}

function Get-AmG2Cursor {
  $p = New-Object AmG2.POINT
  [void][AmG2.Native]::GetCursorPos([ref]$p)
  return @{ x = $p.X; y = $p.Y }
}
function Get-AmG2LastInputTick {
  $li = New-Object AmG2.LASTINPUTINFO
  $li.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($li)
  [void][AmG2.Native]::GetLastInputInfo([ref]$li)
  return [uint32]$li.dwTime
}
function Test-AmG2S1 {
  param([IntPtr]$Hwnd, [string]$ModeName)
  if ($ModeName -eq 'ForceSatisfied') { return $true }
  if ($ModeName -eq 'ForceTimeout') { return $false }
  return ([AmG2.Native]::GetForegroundWindow() -eq $Hwnd)
}

# ---- static self-scan (code lines only; patterns built by explicit concatenation)
function Get-AmG2CodeText([string]$path) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($l in [System.IO.File]::ReadAllLines($path)) {
    if ($l.TrimStart().StartsWith('#')) { continue }
    [void]$sb.AppendLine($l)
  }
  return $sb.ToString()
}
$selfPath = (Resolve-Path $PSScriptRoot).Path + '\g2-negative-path.ps1'
$code = Get-AmG2CodeText $selfPath
$patSw = ('Show' + 'Window' + '(')
$patSf = ('SetFore' + 'groundWindow' + '(')
$frags = @(@('Set', 'CursorPos'), @('mouse_', 'event'), @('Send', 'Input'), @('Send', 'Keys'),
            @('keybd_', 'event'), @('GetCurrent', 'Pattern'), @('Invoke', 'Pattern'),
            @('SetFocus', '('), @('Click', '('), @('BringWindow', 'ToTop'))
$scan = @()
foreach ($fr in $frags) {
  $pat = ($fr -join '')
  $scan += ("forbidden '" + $pat + "' = " + ([regex]::Matches($code, [regex]::Escape($pat))).Count + " (expect 0)")
}
$scan += ("activation '" + $patSw + "' = " + ([regex]::Matches($code, [regex]::Escape($patSw))).Count + " (expect 0)")
$scan += ("activation '" + $patSf + "' = " + ([regex]::Matches($code, [regex]::Escape($patSf))).Count + " (expect 0)")

# ---- target
$list = Get-AmW3AmWindowList
$primary = Get-AmW3PrimaryAmWindow $list
if (-not $primary) { "ASSERT_FAIL: no Apple Music window found"; exit 9 }
$amH = [int64]$primary.hwnd
$amPtr = [IntPtr]$amH

# ---- optional read-only SMTC snapshot (frozen lib used read-only; load failure is recorded, not hidden)
$smtcLoaded = $false; $smtcErr = ''
try {
  . (Join-Path (Split-Path $PSScriptRoot -Parent) 'poc\lib\am-common.ps1')
  . (Join-Path (Split-Path $PSScriptRoot -Parent) 'poc\lib\am-smtc.ps1')
  $smtcLoaded = $true
} catch { $smtcErr = $_.Exception.Message }
$smtcBefore = $null; $smtcAfter = $null
if ($smtcLoaded) { try { $smtcBefore = Get-AmSmtcState } catch { $smtcErr = $_.Exception.Message; $smtcLoaded = $false } }

# ---- pre-audit (real, read-only)
$curBefore = Get-AmG2Cursor
$fgBefore = [int64][AmG2.Native]::GetForegroundWindow()
$tickBefore = Get-AmG2LastInputTick

# ---- the proposed W3 wait (real loop; only the predicate outcome is controlled)
$stepNames = @('geometryRead', 'setCursorPos', 'w4Sleep200', 'mouseDown', 'mouseUp', 'w5Sleep130', 'mouseDown2', 'mouseUp2', 'smtcVerify')
$steps = @{}
foreach ($n in $stepNames) { $steps[$n] = 0 }
$stepOrder = @()
$swWait = [System.Diagnostics.Stopwatch]::StartNew()
$polls = 0
$s1 = $false
while ($swWait.ElapsedMilliseconds -lt $TimeoutMs) {
  $polls++
  if (Test-AmG2S1 $amPtr $Mode) { $s1 = $true; break }
  Start-Sleep -Milliseconds $PollMs
}
$waitMs = [int]$swWait.ElapsedMilliseconds

# ---- branch: this is the control flow under test
$stage = ''
if (-not $s1) {
  $stage = 'W3_FOREGROUND_TIMEOUT'      # returns here: no geometry read, no cursor move, no click
} else {
  $stage = 'S1_SATISFIED'
  foreach ($n in $stepNames) { $steps[$n] = $steps[$n] + 1; $stepOrder += $n }
}

# ---- post-audit (real, read-only)
$curAfter = Get-AmG2Cursor
$fgAfter = [int64][AmG2.Native]::GetForegroundWindow()
$tickAfter = Get-AmG2LastInputTick
if ($smtcLoaded) { try { $smtcAfter = Get-AmSmtcState } catch { $smtcErr = $_.Exception.Message } }

$counterSum = 0
foreach ($n in $stepNames) { $counterSum += $steps[$n] }
$cursorSame = ($curBefore.x -eq $curAfter.x -and $curBefore.y -eq $curAfter.y)
$fgSame = ($fgBefore -eq $fgAfter)
$inputSame = ($tickBefore -eq $tickAfter)
$playbackSame = $null
if ($smtcLoaded -and $smtcBefore -and $smtcAfter) {
  $playbackSame = (($smtcBefore.status -eq $smtcAfter.status) -and ($smtcBefore.title -eq $smtcAfter.title))
}
$verdict = 'FAIL'
if ($Mode -eq 'ForceTimeout') {
  if ((-not $s1) -and ($counterSum -eq 0) -and $cursorSame -and $fgSame -and $inputSame -and ($null -eq $playbackSame -or $playbackSame)) { $verdict = 'PASS' }
} elseif ($Mode -eq 'ForceSatisfied') {
  if ($s1 -and ($counterSum -eq $stepNames.Count) -and $cursorSame -and $fgSame -and $inputSame) { $verdict = 'PASS' }
} else {
  $verdict = 'LIVE_MODE_NOT_PART_OF_G2'
}

$lines = @()
$lines += '=== G2 negative-path test (proposed W3 state substitution) ==='
$lines += "tag=$Tag mode=$Mode timeoutMs=$TimeoutMs requestedPollMs=$PollMs target=$amH"
$lines += "s1Satisfied=$($s1.ToString().ToLower()) stage=$stage waitMs=$waitMs polls=$polls"
$lines += "downstreamReached=$counterSum/$($stepNames.Count) order=[$($stepOrder -join ' > ')]"
$ctr = @()
foreach ($n in $stepNames) { $ctr += ($n + '=' + $steps[$n]) }
$lines += 'counters: ' + ($ctr -join ' ')
$lines += "cursorBefore=($($curBefore.x),$($curBefore.y)) cursorAfter=($($curAfter.x),$($curAfter.y)) cursorUnchanged=$($cursorSame.ToString().ToLower())"
$lines += "foregroundBefore=$fgBefore foregroundAfter=$fgAfter foregroundUnchanged=$($fgSame.ToString().ToLower()) mouseMoved=$(((-not $cursorSame)).ToString().ToLower())"
$lines += "lastInputTickBefore=$tickBefore lastInputTickAfter=$tickAfter anyInputInjected=$(((-not $inputSame)).ToString().ToLower()) keyboardInjected=$(((-not $inputSame)).ToString().ToLower())"
if ($smtcLoaded -and $smtcBefore -and $smtcAfter) {
  $lines += "smtcBefore=status:$($smtcBefore.status) title:$($smtcBefore.title)"
  $lines += "smtcAfter =status:$($smtcAfter.status) title:$($smtcAfter.title)"
  $lines += "playbackOccurred=$(((-not $playbackSame)).ToString().toLower()) playbackMeasured=true"
} else {
  $lines += "playbackMeasured=false smtcLoadError=$smtcErr"
}
$lines += '--- static self-scan (code lines only) ---'
foreach ($s in $scan) { $lines += ('  ' + $s) }
$lines += "VERDICT_$Mode=$verdict"
foreach ($l in $lines) { $l }
$rep = Join-Path $PSScriptRoot ('reports\g2-' + $Tag + '-summary.txt')
[System.IO.File]::WriteAllText($rep, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
"SUMMARY_FILE: $rep"
if ($verdict -ne 'PASS' -and $Mode -ne 'Live') { exit 3 }
