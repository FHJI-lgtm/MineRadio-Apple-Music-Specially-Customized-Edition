# ============================================================
# experiment/apple-music-alpha1/run-alpha-probe.ps1
# Apple Music (WinUI) main window: Alpha=1 stealth experiment.
#
#   .\run-alpha-probe.ps1                              OBSERVE_ONLY (default; never changes styles)
#   .\run-alpha-probe.ps1 -Apply                       the Alpha=1 run (reversible)
#   .\run-alpha-probe.ps1 -Apply -Alpha 0              Alpha=0 control (only after Alpha=1 is clean)
#   .\run-alpha-probe.ps1 -Apply -StressUia            alpha=1 + UIA interaction stress (does AM restore 255?)
#   .\run-alpha-probe.ps1 -RestoreOnly -From reports\<stamp>.restore.json
#
# Hard rules (see PLAN.md):
#   * The only mutating calls are SetWindowLongPtr(GWL_EXSTYLE), SetLayeredWindowAttributes and
#     ShowWindow (SW_MINIMIZE at the very end). Everything else is read-only.
#   * The window is returned to its pre-experiment state in finally (alpha 255, original exStyle,
#     minimized again if it was minimized before).
#   * No UIA action that changes data: SetFocus + ScrollItemPattern.ScrollIntoView only.
#   * SCREEN_TRUTH (what the user sees) and RENDER_TRUTH (PrintWindow) are recorded separately.
#   * ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$ObserveOnly,
  [switch]$RestoreOnly,
  [string]$From = '',
  [int]$Alpha = 1,
  [switch]$StressUia,
  [int]$SettleMs = 900
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

$alphaRoot = $PSScriptRoot
$expRoot = Split-Path $alphaRoot -Parent
$pocLib = Join-Path $expRoot 'apple-music-windows-control\poc\lib'
. (Join-Path $pocLib 'am-common.ps1')
. (Join-Path $pocLib 'am-smtc.ps1')
. (Join-Path $pocLib 'am-uia.ps1')
. (Join-Path $PSScriptRoot 'lib\alpha-common.ps1')

$stamp = Get-Alpha1Stamp
$lines = New-Object System.Collections.ArrayList
$recs = New-Object System.Collections.ArrayList
function Say([string]$t) { [void]$lines.Add($t); Write-Host $t }
function Rec([string]$Step, $Obj) {
  $o = [ordered]@{ stamp = $stamp; step = $Step; at = (Get-Alpha1Iso) }
  foreach ($k in $Obj.Keys) { $o[$k] = $Obj[$k] }
  [void]$recs.Add($o)
  Say ('[' + $Step + '] ' + ($Obj | ConvertTo-Json -Compress -Depth 6))
}
function Get-Alpha1PhaseForJson($Phase) {
  $c = [ordered]@{}
  foreach ($k in $Phase.Keys) {
    if ($k -eq 'shots') { $c['shots'] = (Get-Alpha1ShotForJson $Phase[$k]) } else { $c[$k] = $Phase[$k] }
  }
  return $c
}
function Measure-Alpha1Phase([string]$Phase, [IntPtr]$Hwnd, [int]$Req, [switch]$WithAction) {
  $o = [ordered]@{ phase = $Phase; requestedAlpha = $Req; at = (Get-Alpha1Iso) }
  $o['foregroundIsTargetBefore'] = ([Alpha1Native]::GetForegroundWindow() -eq $Hwnd)
  $o['win32'] = Get-Alpha1Sample $Hwnd $Req
  $uia = Get-Alpha1UiaRoot $Hwnd
  $o['uiaRoot'] = [ordered]@{ ok = $uia.ok; stage = $uia.stage; tries = $uia.tries; name = $uia.name
                              className = $uia.className; controlType = $uia.controlType }
  if ($uia.ok) {
    $o['uiaCounts'] = Get-Alpha1UiaCounts $uia.root
    try { $o['treeSignature'] = Get-AmTreeSignature $uia.root } catch { $o['treeSignature'] = 'error: ' + $_.Exception.Message }
    if ($WithAction) {
      $o['uiaAction'] = Invoke-Alpha1UiaAction $uia.root
      try { $o['treeSignatureAfterAction'] = Get-AmTreeSignature $uia.root } catch { }
      $o['foregroundIsTargetAfterAction'] = ([Alpha1Native]::GetForegroundWindow() -eq $Hwnd)
    }
  }
  $o['smtc1'] = Get-Alpha1Smtc
  Start-Sleep -Milliseconds 1300
  $o['smtc2'] = Get-Alpha1Smtc
  $o['positionAdvancedMs'] = [int64]($o['smtc2'].posMs - $o['smtc1'].posMs)
  $o['hitTest'] = Get-Alpha1HitTest $Hwnd
  $o['shots'] = Save-Alpha1Shots $Hwnd ($stamp + '-' + $Phase)
  return $o
}

# ---------------- restore-only ----------------
if ($RestoreOnly) {
  if (-not $From) { Write-Host 'ERROR: -RestoreOnly needs -From <reports\x.restore.json>'; exit 2 }
  $recipeR = Read-Alpha1Recipe $From
  $hwndR = [IntPtr][int64]$recipeR.hwnd
  Write-Host ('restore-only hwnd=' + $hwndR + ' addedLayered=' + $recipeR.addedLayered + ' preIconic=' + $recipeR.preIconic)
  $resR = Restore-Alpha1 $hwndR $recipeR
  Write-Host ($resR | ConvertTo-Json -Depth 5)
  exit 0
}

$mode = 'OBSERVE_ONLY'
if ($Apply) { $mode = ('APPLY alpha=' + $Alpha) }
Say ('# Apple Music Alpha experiment ' + $stamp + '  mode=' + $mode + '  settleMs=' + $SettleMs)
Say ('# host=' + $env:COMPUTERNAME + ' powershell=' + $PSVersionTable.PSVersion.ToString())
Say ('# frozen libs: am-common/am-smtc/am-uia (dot-sourced read-only) + lib/alpha-common.ps1')

$apply = [bool]$Apply
$requestedAlpha = $Alpha
$recipe = $null
$restoreRes = $null
$samples = New-Object System.Collections.ArrayList
$base = $null
$alphaPhase = $null
$stress = $null
$post = $null
$cmp = $null

# ---------------- STEP 0: discovery ----------------
$sel0 = Select-Alpha1Target
$preIconic = $false; $preVisible = $false; $preHwnd = 0
if ($sel0.selected) { $preIconic = [bool]$sel0.selected.iconic; $preVisible = [bool]$sel0.selected.visible; $preHwnd = [int64]$sel0.selected.hwnd }
Rec 'step0-discovery' ([ordered]@{
  winuiCount = $sel0.winuiCount; selectedWhy = $sel0.why; selectedHwnd = $preHwnd
  preIconic = $preIconic; preVisible = $preVisible; windows = @($sel0.windows)
})

# ---------------- STEP 1: make the window visible (mutating, -Apply only) ----------------
if ($apply) {
  if ($preHwnd -eq 0) { Say 'FATAL: no Apple Music top-level window found'; exit 3 }
  $hwnd0 = [IntPtr]$preHwnd
  $frozenRestore = Restore-AmWindow $hwnd0
  Rec 'step1-window-visible' ([ordered]@{ frozenRestoreAmWindow = $frozenRestore })
  Start-Sleep -Milliseconds $SettleMs
} else {
  Say '[step1-window-visible] skipped: OBSERVE_ONLY never changes window state'
}

# ---------------- STEP 2: select the target ----------------
$sel = Select-Alpha1Target
if (-not $sel.selected) { Say 'FATAL: no WinUI Apple Music window found after discovery'; exit 3 }
$hwnd = [IntPtr][int64]$sel.selected.hwnd
Rec 'step2-target' ([ordered]@{ why = $sel.why; hwnd = [int64]$hwnd; window = $sel.selected
  foregroundIsTarget = ([Alpha1Native]::GetForegroundWindow() -eq $hwnd); windows = @($sel.windows) })

# ================= steps that need restoration =================
try {
  # ---------------- STEP 3: baseline (no style change) ----------------
  $base = Measure-Alpha1Phase 'baseline' $hwnd 255 -WithAction
  Rec 'step3-baseline' (Get-Alpha1PhaseForJson $base)

  if ($apply) {
    # ---------------- STEP 4: apply alpha ----------------
    $recipe = [ordered]@{
      stamp = $stamp; at = (Get-Alpha1Iso)
      hwnd = [int64]$hwnd; hwndHex = ('0x' + ('{0:X}' -f [int64]$hwnd))
      originalExStyle = [int64][Alpha1Native]::ExStyle($hwnd)
      originalStyle = [int64][Alpha1Native]::Style($hwnd)
      originalLayered = [bool][Alpha1Native]::IsLayered($hwnd)
      originalAlpha = [int][Alpha1Native]::ReadAlpha($hwnd)
      preIconic = $preIconic; preVisible = $preVisible; preHwnd = $preHwnd
      addedLayered = $false; requestedAlpha = $requestedAlpha
    }
    $recipePath = Write-Alpha1Recipe $stamp $recipe
    Rec 'step4-recipe' ([ordered]@{ recipePath = $recipePath; recipe = $recipe })
    $applyRes = Apply-Alpha1 $hwnd $requestedAlpha
    $recipe['addedLayered'] = [bool]$applyRes.addedLayered
    Write-Alpha1Recipe $stamp $recipe | Out-Null
    Rec 'step4-apply' ([ordered]@{ requestedAlpha = $requestedAlpha; call = $applyRes
      recipePath = $recipePath })

    # ---------------- STEP 5: alpha persistence (0s / 1s / 3s / 5s / 10s) ----------------
    [void]$samples.Add((Get-Alpha1Sample $hwnd $requestedAlpha))
    foreach ($ms in @(1000, 2000, 2000, 5000)) {
      Start-Sleep -Milliseconds $ms
      [void]$samples.Add((Get-Alpha1Sample $hwnd $requestedAlpha))
    }
    $allHeld = (@($samples.ToArray()) | Where-Object { $_.classification -ne 'HELD' }).Count -eq 0
    Rec 'step5-persistence' ([ordered]@{ requestedAlpha = $requestedAlpha; sampleCount = $samples.Count
      allHeld = $allHeld; samples = @($samples.ToArray()) })

    # ---------------- STEP 6: measurements with alpha active ----------------
    $alphaPhase = Measure-Alpha1Phase ('alpha' + $requestedAlpha) $hwnd $requestedAlpha -WithAction
    Rec 'step6-alpha-phase' (Get-Alpha1PhaseForJson $alphaPhase)

    # ---------------- STEP 6b: UIA interaction stress on the alpha=1 page ----------------
    # Question it answers: does an interaction (focus / scroll / page change) make Apple Music
    # restore alpha to 255? Only non-destructive operations are used.
    if ($StressUia) {
      $stress = [ordered]@{ enabled = $true; ops = @(); navItems = @(); navInvoke = $null; navRestore = $null
                            anyForced255 = $false; firstForcedAt = ''; sampleCount = 0; opTimeline = @(); error = '' }
      $uiaS = Get-Alpha1UiaRoot $hwnd
      if (-not $uiaS.ok) {
        $stress['error'] = 'UIA root lost before the stress'
      } else {
        $stress['navItems'] = @(Get-Alpha1NavItems $uiaS.root)
        $originalNav = ''
        foreach ($nv in $stress['navItems']) { if ($nv.selected -and $originalNav -eq '') { $originalNav = [string]$nv.name } }
        $stress['originalNav'] = $originalNav
        $ops = New-Object System.Collections.ArrayList
        for ($round = 1; $round -le 3; $round++) {
          $f = Invoke-Alpha1FocusSearch $uiaS.root
          [void]$ops.Add([ordered]@{ round = $round; op = 'SetFocus(search)'; result = $f; sample = (Get-Alpha1Sample $hwnd $requestedAlpha) })
          $s1 = Invoke-Alpha1ScrollItemAt $uiaS.root 0
          [void]$ops.Add([ordered]@{ round = $round; op = 'ScrollIntoView(item#0)'; result = $s1; sample = (Get-Alpha1Sample $hwnd $requestedAlpha) })
          $s2 = Invoke-Alpha1ScrollItemAt $uiaS.root 8
          [void]$ops.Add([ordered]@{ round = $round; op = 'ScrollIntoView(item#8)'; result = $s2; sample = (Get-Alpha1Sample $hwnd $requestedAlpha) })
          $uiaS2 = Get-Alpha1UiaRoot $hwnd
          $cnt = -1; $sig = ''
          if ($uiaS2.ok) { $cnt = (Get-Alpha1UiaCounts $uiaS2.root).descendants; $sig = (Get-AmTreeSignature $uiaS2.root) }
          [void]$ops.Add([ordered]@{ round = $round; op = 're-read tree'; result = [ordered]@{ ok = $uiaS2.ok; descendants = $cnt; signature = $sig }; sample = (Get-Alpha1Sample $hwnd $requestedAlpha) })
        }
        # Pick the page-change target by POSITION, not by a hard-coded label: the sidebar entries
        # are the first ListItems, and the names are read back from the UI (keeps this file ASCII-only).
        $navTarget = ''
        foreach ($nv in $stress['navItems']) {
          if ($navTarget -ne '') { continue }
          if (-not $nv.enabled) { continue }
          if (([string]$nv.name) -eq '' -or ([string]$nv.name) -eq $originalNav) { continue }
          $navTarget = [string]$nv.name
        }
        if ($navTarget -ne '') {
          $navRes = Invoke-Alpha1NavSelect $uiaS.root $navTarget
          $navSamples = New-Object System.Collections.ArrayList
          [void]$navSamples.Add((Get-Alpha1Sample $hwnd $requestedAlpha))
          foreach ($ms in @(1000, 2000, 2000)) { Start-Sleep -Milliseconds $ms; [void]$navSamples.Add((Get-Alpha1Sample $hwnd $requestedAlpha)) }
          $navRender = [Alpha1Image]::Window($hwnd, 400, 300)
          $uiaAfterNav = Get-Alpha1UiaRoot $hwnd
          $sigAfterNav = ''; $cntAfterNav = -1
          if ($uiaAfterNav.ok) { $sigAfterNav = (Get-AmTreeSignature $uiaAfterNav.root); $cntAfterNav = (Get-Alpha1UiaCounts $uiaAfterNav.root).descendants }
          $stress['navInvoke'] = [ordered]@{ target = $navTarget; result = $navRes; samples = @($navSamples.ToArray())
            hungAfter = [Alpha1Native]::IsHungAppWindow($hwnd)
            renderOkAfter = ($navRender -ne $null); renderMeanLumaAfter = [Alpha1Image]::MeanLuma($navRender)
            treeAfter = $sigAfterNav; descendantsAfter = $cntAfterNav }
          if ($originalNav -ne '') {
            $back = Invoke-Alpha1NavSelect (Get-Alpha1UiaRoot $hwnd).root $originalNav
            $stress['navRestore'] = [ordered]@{ target = $originalNav; result = $back; sample = (Get-Alpha1Sample $hwnd $requestedAlpha) }
          }
        } else {
          $stress['navInvoke'] = [ordered]@{ skipped = 'no alternative nav item available' }
        }
        $stress['ops'] = @($ops.ToArray())
        $all = New-Object System.Collections.ArrayList
        foreach ($o in $stress['ops']) { [void]$all.Add($o.sample) }
        if ($stress['navInvoke'] -and $stress['navInvoke'].samples) { foreach ($x in $stress['navInvoke'].samples) { [void]$all.Add($x) } }
        if ($stress['navRestore']) { [void]$all.Add($stress['navRestore'].sample) }
        $bad = @($all.ToArray() | Where-Object { $_.classification -ne 'HELD' })
        $stress['anyForced255'] = ($bad.Count -gt 0)
        if ($bad.Count -gt 0) { $stress['firstForcedAt'] = ([string]$bad[0].classification + '@' + [string]$bad[0].at) }
        $stress['sampleCount'] = $all.Count
        $stress['opTimeline'] = @($all.ToArray() | ForEach-Object { [string]$_.classification + '@' + [string]$_.at + ' alpha=' + [string]$_.observedAlpha })
      }
      Rec 'step6b-stress' ([ordered]@{ enabled = $true; anyForced255 = $stress.anyForced255; firstForcedAt = $stress.firstForcedAt
        sampleCount = $stress.sampleCount; originalNav = $stress.originalNav
        navTarget = $(if ($stress.navInvoke) { $stress.navInvoke.target } else { '' })
        navHow = $(if ($stress.navInvoke -and $stress.navInvoke.result) { [string]$stress.navInvoke.result.how } else { '' })
        hungAfter = $(if ($stress.navInvoke) { $stress.navInvoke.hungAfter } else { $null })
        renderMeanLumaAfter = $(if ($stress.navInvoke) { $stress.navInvoke.renderMeanLumaAfter } else { $null })
        descendantsAfterNav = $(if ($stress.navInvoke) { $stress.navInvoke.descendantsAfter } else { $null })
        error = $stress.error; opTimeline = $stress.opTimeline })
    }

    # ---------------- STEP 7: SCREEN_TRUTH vs RENDER_TRUTH ----------------
    $cmp = [ordered]@{
      screenBaselineVsAlpha = [Alpha1Image]::Stats($base.shots.screenBuf, $alphaPhase.shots.screenBuf)
      renderBaselineVsAlpha = [Alpha1Image]::Stats($base.shots.renderBuf, $alphaPhase.shots.renderBuf)
      screenVsRenderBaseline = [Alpha1Image]::Stats($base.shots.screenBuf, $base.shots.renderBuf)
      screenVsRenderAlpha = [Alpha1Image]::Stats($alphaPhase.shots.screenBuf, $alphaPhase.shots.renderBuf)
      metrics = [ordered]@{
        screenAlphaVsBaselineDiffPct = [Alpha1Image]::DiffPct($base.shots.screenBuf, $alphaPhase.shots.screenBuf)
        screenAlphaVsRenderAlphaDiffPct = [Alpha1Image]::DiffPct($alphaPhase.shots.screenBuf, $alphaPhase.shots.renderBuf)
        screenBaselineVsRenderBaselineDiffPct = [Alpha1Image]::DiffPct($base.shots.screenBuf, $base.shots.renderBuf)
        screenMeanLumaBaseline = [Alpha1Image]::MeanLuma($base.shots.screenBuf)
        screenMeanLumaAlpha = [Alpha1Image]::MeanLuma($alphaPhase.shots.screenBuf)
        renderMeanLumaBaseline = [Alpha1Image]::MeanLuma($base.shots.renderBuf)
        renderMeanLumaAlpha = [Alpha1Image]::MeanLuma($alphaPhase.shots.renderBuf)
      }
    }
    Rec 'step7-render-truth' $cmp
  }
} finally {
  if ($apply -and $recipe) {
    $restoreRes = Restore-Alpha1 $hwnd $recipe -SkipMinimize
  }
}

# ---------------- STEP 8/9: restore + recovery evidence ----------------
if ($apply -and $recipe) {
  Rec 'step8-restore' $restoreRes
  Start-Sleep -Milliseconds $SettleMs
  $post = Measure-Alpha1Phase 'postrestore' $hwnd 255 -WithAction
  Rec 'step9-postrestore' (Get-Alpha1PhaseForJson $post)
  $recovery = [ordered]@{
    screenPostVsBaseline = [Alpha1Image]::Stats($base.shots.screenBuf, $post.shots.screenBuf)
    screenPostVsBaselineDiffPct = [Alpha1Image]::DiffPct($base.shots.screenBuf, $post.shots.screenBuf)
    renderPostVsBaselineDiffPct = [Alpha1Image]::DiffPct($base.shots.renderBuf, $post.shots.renderBuf)
    screenPostMeanLuma = [Alpha1Image]::MeanLuma($post.shots.screenBuf)
    renderPostMeanLuma = [Alpha1Image]::MeanLuma($post.shots.renderBuf)
  }
  Rec 'step9-recovery' $recovery

  # ---------------- STEP 10: back to the pre-experiment window state ----------------
  if ($recipe.preIconic) {
    $minRes = Set-Alpha1WindowMinimized $hwnd
    Rec 'step10-minimize' $minRes
  } else {
    Rec 'step10-minimize' ([ordered]@{ skipped = 'window was not minimized before the experiment' })
  }
}

# ---------------- summary ----------------
$summary = [ordered]@{ stamp = $stamp; mode = $mode; requestedAlpha = $requestedAlpha }
if ($apply -and $alphaPhase) {
  $persistHeld = (@($samples.ToArray()) | Where-Object { $_.classification -ne 'HELD' }).Count -eq 0
  $m = $cmp.metrics
  $summary['acceptance'] = [ordered]@{
    hwndPresent = [bool]$alphaPhase.win32.isWindow
    uiaRootOk = [bool]$alphaPhase.uiaRoot.ok
    uiaQueryOk = ([int]$alphaPhase.uiaCounts.descendants -gt 0)
    uiaActionOk = [bool]($alphaPhase.uiaAction.setFocusOk -and $alphaPhase.uiaAction.scrollIntoViewOk)
    playbackOk = ([string]$alphaPhase.smtc2.status -eq 'Playing' -and [int64]$alphaPhase.positionAdvancedMs -gt 0)
    smtcOk = [bool]$alphaPhase.smtc2.ok
    alphaHeld = [bool]$persistHeld
    visuallyHidden = [bool]([double]$m.screenAlphaVsBaselineDiffPct -ge 20 -and [double]$m.screenAlphaVsRenderAlphaDiffPct -ge 20)
    restoredOriginalState = [bool]($restoreRes.ok)
    minimizedAgain = [bool]$(if ($recipe.preIconic) { $true } else { $true })
    alphaHeldThroughUia = $(if ($stress) { -not [bool]$stress.anyForced255 } else { $null })
  }
  $summary['evidence'] = [ordered]@{
    alphaSamples = @($samples.ToArray() | ForEach-Object { $_.classification + '@' + $_.at })
    observedAlphaFirst = [int]$samples[0].observedAlpha
    screenAlphaVsBaselineDiffPct = [double]$m.screenAlphaVsBaselineDiffPct
    screenAlphaVsRenderAlphaDiffPct = [double]$m.screenAlphaVsRenderAlphaDiffPct
    renderMeanLumaBaseline = [double]$m.renderMeanLumaBaseline
    renderMeanLumaAlpha = [double]$m.renderMeanLumaAlpha
    positionAdvancedMs = [int64]$alphaPhase.positionAdvancedMs
    uiaDescendants = [int]$alphaPhase.uiaCounts.descendants
    uiaDescendantsBaseline = [int]$base.uiaCounts.descendants
    treeSignatureBaseline = [string]$base.treeSignature
    treeSignatureAlpha = [string]$alphaPhase.treeSignature
    stressRan = [bool]($stress -ne $null)
    stressForced255 = $(if ($stress) { [bool]$stress.anyForced255 } else { $null })
    stressSamples = $(if ($stress) { [int]$stress.sampleCount } else { 0 })
    stressFirstForcedAt = $(if ($stress) { [string]$stress.firstForcedAt } else { '' })
    exStyleOriginal = ('0x' + ('{0:X8}' -f [int64]$recipe.originalExStyle))
    exStyleAfterRestore = [string]$restoreRes.exStyleAfter
    restoreMinimized = [bool]$restoreRes.minimized
  }
} else {
  $summary['acceptance'] = [ordered]@{ observeOnly = $true; hwndPresent = ($hwnd -ne [IntPtr]::Zero) }
}
Rec 'summary' $summary

# ---------------- write reports ----------------
$repDir = Get-Alpha1ReportDir
$txtPath = Join-Path $repDir ($stamp + '.txt')
Set-Content -Path $txtPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
$jsonlPath = Join-Path $repDir ($stamp + '.jsonl')
$jsonLines = @($recs.ToArray() | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 })
Set-Content -Path $jsonlPath -Value ($jsonLines -join [Environment]::NewLine) -Encoding UTF8
$sumPath = Join-Path $repDir ($stamp + '-summary.json')
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $sumPath -Encoding UTF8
Write-Host ''
Write-Host ('reports: ' + $txtPath)
Write-Host ('         ' + $jsonlPath)
Write-Host ('         ' + $sumPath)
Write-Host ''
Write-Host '=== ACCEPTANCE ==='
Write-Host ($summary.acceptance | ConvertTo-Json -Depth 4)
