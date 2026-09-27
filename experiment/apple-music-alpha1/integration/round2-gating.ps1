# ============================================================
# experiment/apple-music-alpha1/integration/round2-gating.ps1
# Round 2: WS_EX_TRANSPARENT gating. Alpha stays 1 for the WHOLE run; only the transparent bit
# is toggled around the frozen AMC play chain (which plays by synthesizing real clicks).
#
#   idle         alpha=1  transparent=ON   -> stealth + click-through
#   play-start   alpha=1  transparent=OFF  -> the frozen chain can receive real clicks
#   play-verify  alpha=1  transparent=OFF  -> SMTC confirms the target track
#   restored     alpha=1  transparent=ON   -> stealth + click-through again
#
# The gate is a try/finally: whatever happens to the chain, the transparent bit goes back on.
# A deliberate failure injection (bogus chain script) proves that guard.
# Ends by restoring the window completely (alpha 255, original exStyle, SW_MINIMIZE).
# ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [string]$Driver = 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration\amc-chain-driver.js',
  [string]$OutDir = 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration',
  [string]$Target = 'Blinding Lights',
  [string]$FailTarget = 'Levitating',
  [int]$Alpha = 1
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repo = 'F:\mineradio-apple-music'
$pocLib = Join-Path $repo 'experiment\apple-music-windows-control\poc\lib'
. (Join-Path $pocLib 'am-common.ps1')
. (Join-Path $pocLib 'am-smtc.ps1')
. (Join-Path $pocLib 'am-uia.ps1')
. (Join-Path $repo 'experiment\apple-music-alpha1\lib\alpha-common.ps1')

$steps = New-Object System.Collections.ArrayList
function Rec([string]$Name, $Obj) {
  $o = [ordered]@{ step = $Name; at = (Get-Alpha1Iso) }
  foreach ($k in $Obj.Keys) { $o[$k] = $Obj[$k] }
  [void]$steps.Add($o)
  Write-Host ('[' + $Name + '] ' + (($Obj | ConvertTo-Json -Compress -Depth 5)))
}

# 9 relative points inside the current window rect (clamped to the visible screen)
function Get-RelPoints([IntPtr]$H) {
  $rt = [Alpha1Native]::RectText($H)
  $m = [regex]::Match($rt, '^(-?[0-9]+),(-?[0-9]+) ([0-9]+)x([0-9]+)$')
  $out = New-Object System.Collections.ArrayList
  if (-not $m.Success) { return @($out.ToArray()) }
  $rx = [int]$m.Groups[1].Value; $ry = [int]$m.Groups[2].Value
  $rw = [int]$m.Groups[3].Value; $rh = [int]$m.Groups[4].Value
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $mgn = 40
  foreach ($fy in @(0.08, 0.5, 0.92)) {
    foreach ($fx in @(0.08, 0.5, 0.92)) {
      $px = [int]($rx + $rw * $fx); $py = [int]($ry + $rh * $fy)
      if ($px -lt $vs.Left + $mgn -or $px -gt $vs.Left + $vs.Width - $mgn) { continue }
      if ($py -lt $vs.Top + $mgn -or $py -gt $vs.Top + $vs.Height - $mgn) { continue }
      [void]$out.Add(@{ x = $px; y = $py })
    }
  }
  return @($out.ToArray())
}
function Measure-State([string]$Name, [IntPtr]$H) {
  $sample = Get-Alpha1Sample $H $Alpha
  $pts = Get-RelPoints $H
  $am = 0
  foreach ($p in $pts) {
    $pt = New-Object Alpha1Native+POINT; $pt.X = [int]$p.x; $pt.Y = [int]$p.y
    $hit = [Alpha1Native]::WindowFromPoint($pt)
    if (([int64][Alpha1Native]::GetAncestor($hit, 2)) -eq [int64]$H) { $am++ }
  }
  return [ordered]@{ name = $Name; alpha = $sample.observedAlpha; exStyle = $sample.exStyle; layered = $sample.layered
    transparent = $sample.transparent; iconic = $sample.iconic; hung = $sample.hung
    pointsTotal = [int]$pts.Count; pointsStillAppleMusic = [int]$am }
}
function Invoke-ProbeClick([IntPtr]$H, [int]$X, [int]$Y) {
  $before = Get-Alpha1ReceiverCounts
  $uia = Get-Alpha1UiaRoot $H 2 300
  $sigBefore = ''; if ($uia.ok) { try { $sigBefore = Get-AmTreeSignature $uia.root } catch { } }
  $click = Invoke-Alpha1RealClick $X $Y -Button Left
  $after = Get-Alpha1ReceiverCounts
  $uia2 = Get-Alpha1UiaRoot $H 2 300
  $sigAfter = ''; if ($uia2.ok) { try { $sigAfter = Get-AmTreeSignature $uia2.root } catch { } }
  return [ordered]@{ at = (Get-Alpha1Iso); point = ('' + $X + ',' + $Y); cursorAfterSet = [string]$click.cursorAfterSet
    receiverLeftDelta = [int]($after.left - $before.left); uiaTreeBefore = $sigBefore; uiaTreeAfter = $sigAfter
    amStateUnchanged = ($sigBefore -eq $sigAfter) }
}

# THE GATE: open (remove transparent) -> run the frozen chain -> finally close (add transparent back)
function Invoke-GatedChain([string]$Name, [string]$Term, [string]$OutFile, [string]$ChainScript = '') {
  $rec = [ordered]@{ phase = $Name; term = $Term; chainScriptOverride = $ChainScript; openedAt = ''; closedAt = ''; error = ''
    openState = $null; closeState = $null; reopened = $false; play = $null; chainStdout = '' }
  [void](Remove-Alpha1Transparent $script:hwnd)
  $rec.openedAt = Get-Alpha1Iso
  $rec.openState = Measure-State ($Name + '-open') $script:hwnd
  try {
    $args2 = @($Driver, $Term, $OutFile)
    if ($ChainScript -ne '') { $args2 += $ChainScript }
    $out = & node @args2 2>&1
    $rec.chainStdout = (@($out) -join ' | ')
    try { $j = Get-Content $OutFile -Raw | ConvertFrom-Json; $rec.play = $j.steps.play } catch { $rec.play = $null }
  } catch {
    $rec.error = $_.Exception.Message
  } finally {
    $r = Add-Alpha1Transparent $script:hwnd
    $rec.reopened = [bool]$r.ok
    $rec.closedAt = Get-Alpha1Iso
    $rec.closeState = Measure-State ($Name + '-closed') $script:hwnd
  }
  return $rec
}

# ---------------- setup ----------------
$sel0 = Select-Alpha1Target
if (-not $sel0.selected) { Write-Host 'FATAL: no Apple Music window'; exit 3 }
$preIconic = [bool]$sel0.selected.iconic
$frozen = Restore-AmWindow ([IntPtr][int64]$sel0.selected.hwnd)
Start-Sleep -Milliseconds 900
$sel = Select-Alpha1Target
$script:hwnd = [IntPtr][int64]$sel.selected.hwnd
$recipe = [ordered]@{ stamp = (Get-Alpha1Stamp); kind = 'round2-gating'; hwnd = [int64]$script:hwnd
  originalExStyle = [int64][Alpha1Native]::ExStyle($script:hwnd); originalStyle = [int64][Alpha1Native]::Style($script:hwnd)
  originalLayered = [bool][Alpha1Native]::IsLayered($script:hwnd); originalAlpha = [int][Alpha1Native]::ReadAlpha($script:hwnd)
  preIconic = $preIconic; addedLayered = $false; addedTransparent = $false; requestedAlpha = $Alpha }
$recipePath = Write-Alpha1Recipe $recipe.stamp $recipe
Rec 'setup' ([ordered]@{ hwnd = [int64]$script:hwnd; preIconic = $preIconic; frozenRestore = $frozen; recipePath = $recipePath })

$lid = Get-Alpha1ReceiverHits  # force the lib to define the counters
try {
  # base stealth: Alpha=1 (+ LAYERED), Alpha never changes again in this run
  $apply = Apply-Alpha1 $script:hwnd $Alpha
  $recipe['addedLayered'] = [bool]$apply.addedLayered
  $trans = Add-Alpha1Transparent $script:hwnd
  $recipe['addedTransparent'] = $true
  Write-Alpha1Recipe $recipe.stamp $recipe | Out-Null
  Rec 'idle' ([ordered]@{ apply = $apply; transparent = $trans; state = (Measure-State 'idle' $script:hwnd) })

  # receiver directly below Apple Music, so click-through is measurable
  $uia0 = Get-Alpha1UiaRoot $script:hwnd
  $blank = Get-Alpha1BlankSpot $uia0.root $script:hwnd
  $receiver = New-Alpha1Receiver ([int]$blank.x) ([int]$blank.y) 160 100
  $below = Set-Alpha1ReceiverBelow ([IntPtr]$receiver.Handle) $script:hwnd
  Rec 'receiver' ([ordered]@{ blank = $blank; receiverHwnd = [int64]$receiver.Handle; belowAppleMusic = $below })

  # idle: click must pass through to the receiver
  $idleClick = Invoke-ProbeClick $script:hwnd ([int]$blank.x) ([int]$blank.y)
  Rec 'idle-click' ([ordered]@{ probe = $idleClick; expect = 'receiver gets it (click-through)' })

  # ---- gated play: the frozen chain runs with the transparent bit OFF ----------------
  $play1 = Invoke-GatedChain 'play' $Target (Join-Path $OutDir 'round2-gated-play.json')
  Start-Sleep -Seconds 3
  $smtcAfter = Get-AmSmtcState
  Rec 'play-result' ([ordered]@{ gate = $play1; smtcAfter = [ordered]@{ ok = $smtcAfter.ok; title = $smtcAfter.title; artist = $smtcAfter.artist; status = $smtcAfter.status } })

  # restored: click must pass through again
  $restoredClick = Invoke-ProbeClick $script:hwnd ([int]$blank.x) ([int]$blank.y)
  Rec 'restored-click' ([ordered]@{ probe = $restoredClick; state = (Measure-State 'restored' $script:hwnd); expect = 'receiver gets it again (stealth restored)' })

  # ---- failure injection: a bogus chain script must still leave the gate closed --------
  $play2 = Invoke-GatedChain 'fail-injection' $FailTarget (Join-Path $OutDir 'round2-fail-injection.json') 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration\no-such-chain.ps1'
  Start-Sleep -Seconds 2
  $afterFail = Measure-State 'after-fail-injection' $script:hwnd
  $failClick = Invoke-ProbeClick $script:hwnd ([int]$blank.x) ([int]$blank.y)
  Rec 'fail-injection-result' ([ordered]@{ gate = $play2; afterState = $afterFail; probe = $failClick })

  Close-Alpha1Receiver $receiver
  $receiver = $null
} finally {
  if ($receiver) { Close-Alpha1Receiver $receiver; $receiver = $null }
  # the outer restore: alpha 255, original exStyle (clears LAYERED + TRANSPARENT)
  $restoreRes = Restore-Alpha1 $script:hwnd $recipe -SkipMinimize
}

$finalState = Measure-State 'final' $script:hwnd
$smtcFinal = Get-AmSmtcState
Rec 'restore' ([ordered]@{ restore = $restoreRes; finalState = $finalState; smtc = [ordered]@{ title = $smtcFinal.title; status = $smtcFinal.status } })
if ($recipe.preIconic) { $min = Set-Alpha1WindowMinimized $script:hwnd; Rec 'minimize' $min }

$gatedPlay = @($steps.ToArray() | Where-Object { $_.step -eq 'play-result' })[0]
$failInj = @($steps.ToArray() | Where-Object { $_.step -eq 'fail-injection-result' })[0]
$idleClickR = @($steps.ToArray() | Where-Object { $_.step -eq 'idle-click' })[0]
$restoredClickR = @($steps.ToArray() | Where-Object { $_.step -eq 'restored-click' })[0]
$checklist = [ordered]@{
  searchOk = ($null -ne $gatedPlay.gate.play -and $gatedPlay.gate.play.ok)
  trackSwitched = ($gatedPlay.smtcAfter.title -like ('*' + $Target + '*'))
  verified = ($null -ne $gatedPlay.gate.play -and [bool]$gatedPlay.gate.play.verified)
  smtcTargetCorrect = ($gatedPlay.smtcAfter.title -like ('*' + $Target + '*'))
  # NOTE: only the stealth-phase states count here; the post-restore final state has no LAYERED
  # style any more, so alpha=-1 there is correct and must not be read as a violation.
  alphaHeldEverywhere = (@($steps.ToArray() | ForEach-Object { if ($_.state) { $_.state } ; if ($_.gate) { $_.gate.openState; $_.gate.closeState } } | Where-Object { $_ -ne $null } | Where-Object { $_.alpha -ne $Alpha }).Count -eq 0)
  statesWithNoPoints = (@($steps.ToArray() | ForEach-Object { if ($_.state) { $_.state } ; if ($_.gate) { $_.gate.openState; $_.gate.closeState } } | Where-Object { $_ -ne $null -and $_.pointsTotal -eq 0 }).Count)
  reopenedAfterPlay = [bool]$gatedPlay.gate.reopened
  reopenedAfterFailure = [bool]$failInj.gate.reopened
  clickThroughWhileIdle = ([int]$idleClickR.probe.receiverLeftDelta -gt 0)
  clickThroughRestored = ([int]$restoredClickR.probe.receiverLeftDelta -gt 0)
  amHitInvisibleWhileIdle = (@($steps.ToArray() | Where-Object { $_.state -and $_.state.name -like 'idle*' })[0].state.pointsStillAppleMusic -eq 0)
  amHitVisibleWhileOpen = (@($steps.ToArray() | Where-Object { $_.gate })[0].gate.openState.pointsStillAppleMusic -gt 0)
  restoredOriginalExStyle = [bool]$restoreRes.matchesOriginal
  minimizedAtEnd = [bool]$finalState.iconic
}
$summary = [ordered]@{ at = (Get-Alpha1Iso); alpha = $Alpha; target = $Target; recipePath = $recipePath; checklist = $checklist; steps = @($steps.ToArray()) }
$sumFile = Join-Path $OutDir 'round2-gating-summary.json'
$summary | ConvertTo-Json -Depth 10 | Set-Content -Path $sumFile -Encoding UTF8
Write-Host ''
Write-Host '=== ROUND 2 CHECKLIST ==='
Write-Host ($checklist | ConvertTo-Json -Depth 4)
Write-Host ('summary: ' + $sumFile)