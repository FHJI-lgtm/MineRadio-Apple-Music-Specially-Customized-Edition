# ============================================================
# experiment/apple-music-alpha1/run-click-through.ps1
# Phase B: Alpha=1 + WS_EX_TRANSPARENT -> does the mouse pass through while UIA stays alive?
#
#   .\run-click-through.ps1                 (Alpha=1 + transparent; reversible)
#   .\run-click-through.ps1 -SkipControlClick
#
# Method: a tiny OWNED receiver window is placed directly BELOW Apple Music at a point inside
# the Apple Music rect that is not covered by any interactive UIA element. A real synthesized
# click is then made at that point three times:
#   A) alpha=1, no WS_EX_TRANSPARENT  -> Apple Music must eat it   (receiver hits stay 0)
#   B) alpha=1 + WS_EX_TRANSPARENT    -> the receiver must get it  (receiver hits +1)
#   C) transparent removed again      -> Apple Music must eat it again (receiver unchanged)
# WindowFromPoint is recorded at every stage; the UIA tree signature is compared before/after
# each click so we can prove the click did not change Apple Music's state.
#
# Only these mutate: SetWindowLongPtr(GWL_EXSTYLE), SetLayeredWindowAttributes, ShowWindow,
# and one real synthesized click (plus a 140x90 helper form that is closed again).
# ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [int]$Alpha = 1,
  [int]$SettleMs = 900,
  [switch]$SkipControlClick
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
. (Join-Path $alphaRoot 'lib\alpha-common.ps1')

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

# UIA triple check: root / queries / operations (focus, scroll-into-view, sidebar selection)
function Measure-Alpha1UiaBlock([IntPtr]$Hwnd, [switch]$WithAction) {
  $o = [ordered]@{ at = (Get-Alpha1Iso) }
  $uia = Get-Alpha1UiaRoot $Hwnd
  $o['root'] = [ordered]@{ ok = $uia.ok; stage = $uia.stage; name = $uia.name; className = $uia.className; tries = $uia.tries }
  if ($uia.ok) {
    $o['counts'] = Get-Alpha1UiaCounts $uia.root
    try { $o['treeSignature'] = Get-AmTreeSignature $uia.root } catch { $o['treeSignature'] = 'error' }
    if ($WithAction) {
      $o['action'] = Invoke-Alpha1UiaAction $uia.root
      $nav = Get-Alpha1NavItems $uia.root
      $selectedNav = ''
      foreach ($nv in $nav) { if ($nv.selected -and $selectedNav -eq '') { $selectedNav = [string]$nv.name } }
      $targetNav = ''
      foreach ($nv in $nav) {
        if ($targetNav -eq '' -and $nv.enabled -and ([string]$nv.name) -ne '' -and ([string]$nv.name) -ne $selectedNav) { $targetNav = [string]$nv.name }
      }
      $o['navSelectedBefore'] = $selectedNav
      if ($targetNav -ne '') {
        $selRes = Invoke-Alpha1NavSelect $uia.root $targetNav
        Start-Sleep -Milliseconds 700
        $o['navSelect'] = [ordered]@{ target = $targetNav; result = $selRes }
        $uia2 = Get-Alpha1UiaRoot $Hwnd
        if ($uia2.ok) { $o['countsAfterNav'] = Get-Alpha1UiaCounts $uia2.root }
        if ($selectedNav -ne '') {
          $back = Invoke-Alpha1NavSelect (Get-Alpha1UiaRoot $Hwnd).root $selectedNav
          Start-Sleep -Milliseconds 500
          $o['navRestore'] = [ordered]@{ target = $selectedNav; result = $back }
        }
      }
      try { $o['treeSignatureAfterAction'] = Get-AmTreeSignature (Get-Alpha1UiaRoot $Hwnd).root } catch { }
    }
  }
  return $o
}

# One click probe: hit test + (optional) real click + receiver counter + AM state check
function Invoke-Alpha1ClickProbe([IntPtr]$Hwnd, [int]$X, [int]$Y, [switch]$Click, [string]$Label) {
  $o = [ordered]@{ label = $Label; at = (Get-Alpha1Iso); point = ($X.ToString() + ',' + $Y.ToString()) }
  $pt = New-Object Alpha1Native+POINT
  $pt.X = $X; $pt.Y = $Y
  $hit = [Alpha1Native]::WindowFromPoint($pt)
  $o['hitHwnd'] = [int64]$hit
  $o['hitClass'] = [Alpha1Native]::ClassName($hit)
  $o['hitRoot'] = [int64][Alpha1Native]::GetAncestor($hit, 2)
  $o['hitIsAppleMusic'] = (([int64][Alpha1Native]::GetAncestor($hit, 2)) -eq [int64]$Hwnd)
  $uiaBefore = Get-Alpha1UiaRoot $Hwnd
  if ($uiaBefore.ok) { try { $o['treeBefore'] = Get-AmTreeSignature $uiaBefore.root } catch { } }
  $o['receiverHitsBefore'] = Get-Alpha1ReceiverHits
  if ($Click) {
    $o['click'] = Invoke-Alpha1RealClick $X $Y
    for ($p = 0; $p -lt 8; $p++) { try { [System.Windows.Forms.Application]::DoEvents() } catch { } ; Start-Sleep -Milliseconds 25 }
    $o['receiverHitsAfter'] = Get-Alpha1ReceiverHits
    $o['receiverGotClick'] = ([int]$o['receiverHitsAfter'] -gt [int]$o['receiverHitsBefore'])
  }
  $uiaAfter = Get-Alpha1UiaRoot $Hwnd
  if ($uiaAfter.ok) { try { $o['treeAfter'] = Get-AmTreeSignature $uiaAfter.root } catch { } }
  $o['amStateUnchanged'] = ([string]$o['treeBefore'] -eq [string]$o['treeAfter'])
  return $o
}

$cursorStart = $null
try { $cursorStart = [System.Windows.Forms.Cursor]::Position } catch { }

# ---------------- P0: discovery + make the window visible ----------------
$sel0 = Select-Alpha1Target
if (-not $sel0.selected) { Say 'FATAL: no Apple Music window'; exit 3 }
$preIconic = [bool]$sel0.selected.iconic
$hwnd = [IntPtr][int64]$sel0.selected.hwnd
Rec 'p0-discovery' ([ordered]@{ selectedWhy = $sel0.why; hwnd = [int64]$hwnd; preIconic = $preIconic; window = $sel0.selected })
$frozen = Restore-AmWindow $hwnd
Rec 'p0-window-visible' ([ordered]@{ frozenRestoreAmWindow = $frozen })
Start-Sleep -Milliseconds $SettleMs
$sel = Select-Alpha1Target
$hwnd = [IntPtr][int64]$sel.selected.hwnd
Rec 'p0-target' ([ordered]@{ hwnd = [int64]$hwnd; window = $sel.selected })

$recipe = [ordered]@{
  stamp = $stamp; at = (Get-Alpha1Iso); kind = 'click-through'
  hwnd = [int64]$hwnd; hwndHex = ('0x' + ('{0:X}' -f [int64]$hwnd))
  originalExStyle = [int64][Alpha1Native]::ExStyle($hwnd)
  originalStyle = [int64][Alpha1Native]::Style($hwnd)
  originalLayered = [bool][Alpha1Native]::IsLayered($hwnd)
  originalAlpha = [int][Alpha1Native]::ReadAlpha($hwnd)
  preIconic = $preIconic; addedLayered = $false; addedTransparent = $false; requestedAlpha = $Alpha
}
$recipePath = Write-Alpha1Recipe $stamp $recipe
Rec 'p0-recipe' ([ordered]@{ recipePath = $recipePath; recipe = $recipe })

$receiver = $null
$result = [ordered]@{}
$restoreRes = $null
try {
  # ---------------- P1: apply LAYERED + alpha ----------------
  $applyRes = Apply-Alpha1 $hwnd $Alpha
  $recipe['addedLayered'] = [bool]$applyRes.addedLayered
  Rec 'p1-apply-alpha' ([ordered]@{ call = $applyRes; sample = (Get-Alpha1Sample $hwnd $Alpha) })

  # ---------------- P2: blank spot + receiver + CONTROL click (AM must eat it) ----------------
  $uiaP2 = Get-Alpha1UiaRoot $hwnd
  $spot = Get-Alpha1BlankSpot $uiaP2.root $hwnd
  Rec 'p2-blank-spot' $spot
  if (-not $spot.ok) { Say ('FATAL: no blank spot inside the Apple Music rect (' + $spot.reason + ')'); exit 4 }
  $receiver = New-Alpha1Receiver $spot.x $spot.y
  $belowRes = Set-Alpha1ReceiverBelow ([IntPtr]$receiver.Handle) $hwnd
  Rec 'p2-receiver' ([ordered]@{ spot = $spot; receiverHwnd = [int64]$receiver.Handle; belowAppleMusic = $belowRes })
  $control = Invoke-Alpha1ClickProbe $hwnd $spot.x $spot.y -Click:(-not $SkipControlClick) -Label 'A: alpha=1, no WS_EX_TRANSPARENT (control)'
  $result['controlAmEatsClick'] = (-not $control.receiverGotClick)
  Rec 'p2-control-click' $control

  # ---------------- P3: add WS_EX_TRANSPARENT ----------------
  $trans = Add-Alpha1Transparent $hwnd
  $recipe['addedTransparent'] = $true
  Write-Alpha1Recipe $stamp $recipe | Out-Null
  Rec 'p3-add-transparent' ([ordered]@{ call = $trans; sample = (Get-Alpha1Sample $hwnd $Alpha) })
  $pass = Invoke-Alpha1ClickProbe $hwnd $spot.x $spot.y -Click -Label 'B: alpha=1 + WS_EX_TRANSPARENT (pass-through)'
  $result['transparentPassesClick'] = [bool]$pass.receiverGotClick
  $result['hitStillAppleMusic'] = [bool]$pass.hitIsAppleMusic
  Rec 'p3-passthrough-click' $pass
  $renderBuf = [Alpha1Image]::Window($hwnd, 400, 300)
  $uiaP3 = Measure-Alpha1UiaBlock $hwnd -WithAction
  Rec 'p3-uia-under-transparent' $uiaP3
  $sampleP3 = Get-Alpha1Sample $hwnd $Alpha
  $smtcP3 = Get-Alpha1Smtc
  Rec 'p3-state' ([ordered]@{ sample = $sampleP3; smtc = $smtcP3
    renderOk = ($null -ne $renderBuf); renderMeanLuma = [Alpha1Image]::MeanLuma($renderBuf)
    hung = [Alpha1Native]::IsHungAppWindow($hwnd) })
  $result['alphaHeldWithTransparent'] = ([string]$sampleP3.classification -eq 'HELD')
  $result['uiaOkWithTransparent'] = ([bool]$uiaP3.root.ok -and [int]$uiaP3.counts.descendants -gt 0 -and [bool]$uiaP3.action.setFocusOk -and [bool]$uiaP3.action.scrollIntoViewOk)
  $result['selectionPatternOkWithTransparent'] = [bool]($uiaP3.navSelect -and $uiaP3.navSelect.result.ok)
  $result['playbackOkWithTransparent'] = ([string]$smtcP3.status -eq 'Playing')

  # ---------------- P4: remove WS_EX_TRANSPARENT -> AM must eat the click again ----------------
  $untrans = Remove-Alpha1Transparent $hwnd
  Rec 'p4-remove-transparent' ([ordered]@{ call = $untrans; sample = (Get-Alpha1Sample $hwnd $Alpha) })
  $uiaP4 = Get-Alpha1UiaRoot $hwnd
  $spot2 = Get-Alpha1BlankSpot $uiaP4.root $hwnd
  if ($spot2.ok -and $receiver) {
    $receiver.Location = New-Object System.Drawing.Point(([int]$spot2.x - 70), ([int]$spot2.y - 45))
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 200
    Set-Alpha1ReceiverBelow ([IntPtr]$receiver.Handle) $hwnd | Out-Null
  }
  $after = Invoke-Alpha1ClickProbe $hwnd $spot2.x $spot2.y -Click -Label 'C: transparent removed (AM must eat it again)'
  $result['removalRestoresBlocking'] = (-not $after.receiverGotClick)
  Rec 'p4-after-removal-click' ([ordered]@{ spot = $spot2; probe = $after })
} finally {
  if ($receiver) { Close-Alpha1Receiver $receiver; $receiver = $null }
  $restoreRes = Restore-Alpha1 $hwnd $recipe -SkipMinimize
}

Rec 'p5-restore' $restoreRes
$result['restoredOriginalExStyle'] = [bool]$restoreRes.matchesOriginal
Start-Sleep -Milliseconds $SettleMs
$post = Measure-Alpha1UiaBlock $hwnd -WithAction
$postSample = Get-Alpha1Sample $hwnd 255
Rec 'p6-postrestore' ([ordered]@{ sample = $postSample; uia = $post; smtc = (Get-Alpha1Smtc) })
$result['uiaRecoveredAfterRestore'] = ([bool]$post.root.ok -and [int]$post.counts.descendants -gt 0)

if ($recipe.preIconic) {
  $minRes = Set-Alpha1WindowMinimized $hwnd
  Rec 'p7-minimize' $minRes
} else {
  Rec 'p7-minimize' ([ordered]@{ skipped = 'window was not minimized before the experiment' })
}
if ($cursorStart) { try { [System.Windows.Forms.Cursor]::Position = $cursorStart } catch { } }

$summary = [ordered]@{ stamp = $stamp; kind = 'click-through'; requestedAlpha = $Alpha; result = $result
  recipe = $recipe; recipePath = $recipePath }
Rec 'summary' $summary

$repDir = Get-Alpha1ReportDir
$txtPath = Join-Path $repDir ($stamp + '-clickthrough.txt')
Set-Content -Path $txtPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
$jsonlPath = Join-Path $repDir ($stamp + '-clickthrough.jsonl')
$jsonLines = @($recs.ToArray() | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 })
Set-Content -Path $jsonlPath -Value ($jsonLines -join [Environment]::NewLine) -Encoding UTF8
$sumPath = Join-Path $repDir ($stamp + '-clickthrough-summary.json')
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $sumPath -Encoding UTF8
Write-Host ''
Write-Host ('reports: ' + $txtPath)
Write-Host ('         ' + $jsonlPath)
Write-Host ('         ' + $sumPath)
Write-Host ''
Write-Host '=== CLICK-THROUGH RESULT ==='
Write-Host ($result | ConvertTo-Json -Depth 6)