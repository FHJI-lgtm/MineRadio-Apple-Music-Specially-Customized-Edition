# ============================================================
# experiment/apple-music-alpha1/run-clickthrough-sweep.ps1
# Phase B+: whole-window hit-test sweep + real mouse input types (left / right / wheel).
#
#   .\run-clickthrough-sweep.ps1                (Alpha=1 + WS_EX_TRANSPARENT, reversible)
#   .\run-clickthrough-sweep.ps1 -Grid 240 -InputPoints 9
#
# PASS definition (agreed with the reviewer):
#   1. every scanned point: WindowFromPoint root != Apple Music root
#   2. at least one REAL mouse event is received by the underlying window
#   3. UIA root / queries / operations still work under the transparent style
# plus: Alpha stays 1, playback/SMTC keep running, and everything is restored afterwards.
#
# The underlying window is an owned helper form sized to the Apple Music rect and placed
# directly BELOW Apple Music, so any click that skips Apple Music must land on it.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [int]$Alpha = 1,
  [int]$Grid = 240,
  [int]$SettleMs = 800,
  [int]$InputPoints = 9
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
  $json = $Obj | ConvertTo-Json -Compress -Depth 6
  Say ('[' + $Step + '] ' + $json)
}
function Get-Alpha1PointHit([IntPtr]$Hwnd, [int]$X, [int]$Y) {
  $pt = New-Object Alpha1Native+POINT
  $pt.X = $X; $pt.Y = $Y
  $hit = [Alpha1Native]::WindowFromPoint($pt)
  $root = [Alpha1Native]::GetAncestor($hit, 2)
  return [ordered]@{ x = $X; y = $Y; hwnd = [int64]$hit; class = [Alpha1Native]::ClassName($hit); root = [int64]$root; isAppleMusic = ([int64]$root -eq [int64]$Hwnd) }
}

$cursorStart = $null
try { $cursorStart = [System.Windows.Forms.Cursor]::Position } catch { }
$wheelRouting = 'unknown'
try { $wheelRouting = '' + (Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'MouseWheelRouting' -ErrorAction SilentlyContinue).MouseWheelRouting } catch { }

# ---------------- P0 ----------------
$sel0 = Select-Alpha1Target
if (-not $sel0.selected) { Say 'FATAL: no Apple Music window'; exit 3 }
$preIconic = [bool]$sel0.selected.iconic
$hwnd = [IntPtr][int64]$sel0.selected.hwnd
$frozen = Restore-AmWindow $hwnd
Start-Sleep -Milliseconds $SettleMs
$sel = Select-Alpha1Target
$hwnd = [IntPtr][int64]$sel.selected.hwnd
Rec 'p0-window' ([ordered]@{ hwnd = [int64]$hwnd; preIconic = $preIconic; frozenRestore = $frozen; window = $sel.selected; mouseWheelRouting = $wheelRouting })

$recipe = [ordered]@{
  stamp = $stamp; at = (Get-Alpha1Iso); kind = 'click-through-sweep'
  hwnd = [int64]$hwnd; originalExStyle = [int64][Alpha1Native]::ExStyle($hwnd)
  originalStyle = [int64][Alpha1Native]::Style($hwnd); originalLayered = [bool][Alpha1Native]::IsLayered($hwnd)
  originalAlpha = [int][Alpha1Native]::ReadAlpha($hwnd); preIconic = $preIconic
  addedLayered = $false; addedTransparent = $false; requestedAlpha = $Alpha
}
$recipePath = Write-Alpha1Recipe $stamp $recipe
Rec 'p0-recipe' ([ordered]@{ recipePath = $recipePath; recipe = $recipe })

$receiver = $null
$sweep = @()
$result = [ordered]@{}
$restoreRes = $null
try {
  # ---------------- P1: alpha ----------------
  $applyRes = Apply-Alpha1 $hwnd $Alpha
  $recipe['addedLayered'] = [bool]$applyRes.addedLayered
  Rec 'p1-apply-alpha' ([ordered]@{ call = $applyRes; sample = (Get-Alpha1Sample $hwnd $Alpha) })

  # ---------------- P2: sample points ----------------
  $uia = Get-Alpha1UiaRoot $hwnd
  if (-not $uia.ok) { Say 'FATAL: UIA root not available'; exit 4 }
  $boxes = Get-Alpha1InteractiveBoxes $uia.root
  $rt = [Alpha1Native]::RectText($hwnd)
  $m = [regex]::Match($rt, '^(-?[0-9]+),(-?[0-9]+) ([0-9]+)x([0-9]+)$')
  $x0 = [int]$m.Groups[1].Value; $y0 = [int]$m.Groups[2].Value
  $ww = [int]$m.Groups[3].Value; $hh = [int]$m.Groups[4].Value
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $margin = 60
  $l = [Math]::Max($x0, $vs.Left + $margin); $t = [Math]::Max($y0, $vs.Top + $margin)
  $r = [Math]::Min($x0 + $ww, $vs.Left + $vs.Width - $margin); $b = [Math]::Min($y0 + $hh, $vs.Top + $vs.Height - $margin)
  $pts = New-Object System.Collections.ArrayList
  $seen = @{}
  $addPoint = {
    param($list, $map, [int]$x, [int]$y, [string]$region)
    $k = ($x.ToString() + ',' + $y.ToString())
    if ($map.ContainsKey($k)) { return }
    $map[$k] = $true
    [void]$list.Add([ordered]@{ x = $x; y = $y; region = $region })
  }
  for ($gy = $t; $gy -le $b; $gy += $Grid) { for ($gx = $l; $gx -le $r; $gx += $Grid) { & $addPoint $pts $seen $gx $gy 'grid' } }
  & $addPoint $pts $seen ($l + 20) ($t + 20) 'corner-tl'
  & $addPoint $pts $seen ($r - 20) ($t + 20) 'corner-tr'
  & $addPoint $pts $seen ($l + 20) ($b - 20) 'corner-bl'
  & $addPoint $pts $seen ($r - 20) ($b - 20) 'corner-br'
  & $addPoint $pts $seen ([int](($l + $r) / 2)) $t 'edge-top'
  & $addPoint $pts $seen ([int](($l + $r) / 2)) $b 'edge-bottom'
  & $addPoint $pts $seen $l ([int](($t + $b) / 2)) 'edge-left'
  & $addPoint $pts $seen $r ([int](($t + $b) / 2)) 'edge-right'
  & $addPoint $pts $seen ([int](($l + $r) / 2)) ([int](($t + $b) / 2)) 'center'
  $pickBox = {
    param($list, [string]$kind, [double]$minLeft, [double]$maxLeft)
    foreach ($bx in $list) {
      if ($bx.kind -ne $kind) { continue }
      if ($bx.l -lt $minLeft) { continue }
      if ($maxLeft -gt 0 -and $bx.l -gt $maxLeft) { continue }
      return $bx
    }
    return $null
  }
  $searchBox = & $pickBox $boxes 'Edit' 0 0
  $navBox = & $pickBox $boxes 'ListItem' 0 420
  $listBox = & $pickBox $boxes 'ListItem' ($x0 + [int]($ww * 0.4)) 0
  if ($searchBox) { & $addPoint $pts $seen ([int](($searchBox.l + $searchBox.rr) / 2)) ([int](($searchBox.t + $searchBox.bb) / 2)) 'search-region' }
  if ($navBox) { & $addPoint $pts $seen ([int](($navBox.l + $navBox.rr) / 2)) ([int](($navBox.t + $navBox.bb) / 2)) 'nav-region' }
  if ($listBox) { & $addPoint $pts $seen ([int](($listBox.l + $listBox.rr) / 2)) ([int](($listBox.t + $listBox.bb) / 2)) 'list-region' }
  $blank = Get-Alpha1BlankSpot $uia.root $hwnd
  if ($blank.ok) { & $addPoint $pts $seen ([int]$blank.x) ([int]$blank.y) 'blank-region' }
  $sweep = @($pts.ToArray())
  Rec 'p2-points' ([ordered]@{ total = $sweep.Count; interactiveBoxes = $boxes.Count; blank = $blank; bounds = ('' + $l + ',' + $t + ' ' + ($r - $l) + 'x' + ($b - $t)); virtualScreen = ('' + $vs.Left + ',' + $vs.Top + ' ' + $vs.Width + 'x' + $vs.Height); regions = @($sweep | Group-Object { $_.region } | ForEach-Object { $_.Name + '=' + $_.Count }) })

  # ---------------- P3: helper receiver covering the window rect, directly below Apple Music ----------------
  $recW = [Math]::Min($vs.Width, $ww); $recH = [Math]::Min($vs.Height, $hh)
  $receiver = New-Alpha1Receiver ([int]($l + ($r - $l) / 2)) ([int]($t + ($b - $t) / 2)) ($r - $l) ($b - $t)
  $below = Set-Alpha1ReceiverBelow ([IntPtr]$receiver.Handle) $hwnd
  Rec 'p3-receiver' ([ordered]@{ receiverHwnd = [int64]$receiver.Handle; size = ('' + ($r - $l) + 'x' + ($b - $t)); belowAppleMusic = $below })

  # ---------------- P3b: add WS_EX_TRANSPARENT (the style this phase is about) ----------------
  $trans = Add-Alpha1Transparent $hwnd
  $recipe['addedTransparent'] = $true
  Write-Alpha1Recipe $stamp $recipe | Out-Null
  Rec 'p3b-add-transparent' ([ordered]@{ call = $trans; sample = (Get-Alpha1Sample $hwnd $Alpha) })

  # ---------------- P4: hit-test sweep (transparent ON) ----------------
  $sweepHits = New-Object System.Collections.ArrayList
  foreach ($p in $sweep) {
    $hit = Get-Alpha1PointHit $hwnd ([int]$p.x) ([int]$p.y)
    $kind = Test-Alpha1PointInBoxes ([int]$p.x) ([int]$p.y) $boxes
    [void]$sweepHits.Add([ordered]@{ region = $p.region; x = $p.x; y = $p.y; insideInteractive = $kind; hitClass = $hit.class; hitRoot = $hit.root; hitIsAppleMusic = $hit.isAppleMusic; hitIsReceiver = ($hit.root -eq [int64]$receiver.Handle) })
  }
  $stillAm = @($sweepHits.ToArray() | Where-Object { $_.hitIsAppleMusic })
  $hitsReceiver = @($sweepHits.ToArray() | Where-Object { $_.hitIsReceiver })
  $result['allPointsSkipAppleMusic'] = ($stillAm.Count -eq 0)
  $result['allPointsHitReceiver'] = ($hitsReceiver.Count -eq $sweepHits.Count)
  Rec 'p4-hit-sweep' ([ordered]@{ points = $sweepHits.Count; stillAppleMusic = $stillAm.Count; hitReceiver = $hitsReceiver.Count; pointsDetail = @($sweepHits.ToArray() | ForEach-Object { $_.region + '@' + $_.x + ',' + $_.y + ' inside=' + $_.insideInteractive + ' hit=' + $_.hitClass + ' isAm=' + $_.hitIsAppleMusic + ' isReceiver=' + $_.hitIsReceiver }) })

  # ---------------- P5: real left + right clicks on a spread subset ----------------
  # Real input is probed where the hit test says the RECEIVER is the window below Apple Music;
  # points covered by another topmost window (Lyricify Lite overlay / taskbar) cannot attribute a
  # click to us, so they are only part of the hit-test criterion (root != Apple Music).
  $coveredBy = @($sweepHits.ToArray() | Where-Object { -not $_.hitIsReceiver } | Group-Object { $_.hitClass } | ForEach-Object { $_.Name + '=' + $_.Count })
  $receiverWins = @($sweepHits.ToArray() | Where-Object { $_.hitIsReceiver })
  $subset = @($receiverWins | Select-Object -First $InputPoints)
  if ($subset.Count -eq 0) { $subset = @($sweep | Where-Object { $_.region -ne 'grid' } | Select-Object -First $InputPoints) }
  $realInput = New-Object System.Collections.ArrayList
  foreach ($p in $subset) {
    $before = Get-Alpha1ReceiverCounts
    $clickL = Invoke-Alpha1RealClick ([int]$p.x) ([int]$p.y) -Button Left
    $afterL = Get-Alpha1ReceiverCounts
    $beforeR = $afterL
    $clickR = Invoke-Alpha1RealClick ([int]$p.x) ([int]$p.y) -Button Right
    $afterR = Get-Alpha1ReceiverCounts
    [void]$realInput.Add([ordered]@{ region = $p.region; x = $p.x; y = $p.y
      leftDelta = ([int]$afterL.left - [int]$before.left); rightDelta = ([int]$afterR.right - [int]$beforeR.right)
      cursorAfterSet = [string]$clickL.cursorAfterSet; clickOkL = [bool]$clickL.ok; clickOkR = [bool]$clickR.ok })
  }
  $delivered = @($realInput.ToArray() | Where-Object { ($_.leftDelta + $_.rightDelta) -gt 0 })
  $result['realMouseEventDelivered'] = ($delivered.Count -gt 0)
  $result['deliveredPoints'] = $delivered.Count
  Rec 'p5-real-input' ([ordered]@{ tested = $realInput.Count; deliveredPoints = $delivered.Count; receiverWinPoints = $receiverWins.Count; coveredByOtherWindows = $coveredBy; events = @($realInput.ToArray()) })

  # ---------------- P6: wheel ----------------
  $wheelPts = @($subset | Where-Object { $_.region -in @('center', 'list-region', 'blank-region') })
  if ($wheelPts.Count -eq 0) { $wheelPts = @($subset | Select-Object -First 3) }
  $wheelRes = New-Object System.Collections.ArrayList
  foreach ($p in $wheelPts) {
    $b4 = Get-Alpha1ReceiverCounts
    $w = Invoke-Alpha1RealWheel ([int]$p.x) ([int]$p.y) 120
    $af = Get-Alpha1ReceiverCounts
    [void]$wheelRes.Add([ordered]@{ region = $p.region; x = $p.x; y = $p.y; delta = ([int]$af.wheel - [int]$b4.wheel); ok = [bool]$w.ok })
  }
  $wheelDelivered = @($wheelRes.ToArray() | Where-Object { $_.delta -gt 0 })
  $result['wheelDeliveredToReceiver'] = ($wheelDelivered.Count -gt 0)
  Rec 'p6-wheel' ([ordered]@{ mouseWheelRouting = $wheelRouting; tested = $wheelRes.Count; delivered = $wheelDelivered.Count; events = @($wheelRes.ToArray()) })

  # ---------------- P7: UIA under the transparent style ----------------
  $uiaT = Get-Alpha1UiaRoot $hwnd
  $uiaBlock = [ordered]@{ root = [ordered]@{ ok = $uiaT.ok; name = $uiaT.name; className = $uiaT.className } }
  if ($uiaT.ok) {
    $uiaBlock['counts'] = Get-Alpha1UiaCounts $uiaT.root
    try { $uiaBlock['treeSignature'] = Get-AmTreeSignature $uiaT.root } catch { }
    $uiaBlock['action'] = Invoke-Alpha1UiaAction $uiaT.root
    $nav = Get-Alpha1NavItems $uiaT.root
    $selNav = ''
    foreach ($nv in $nav) { if ($nv.selected -and $selNav -eq '') { $selNav = [string]$nv.name } }
    $tgt = ''
    foreach ($nv in $nav) { if ($tgt -eq '' -and $nv.enabled -and ([string]$nv.name) -ne '' -and ([string]$nv.name) -ne $selNav) { $tgt = [string]$nv.name } }
    if ($tgt -ne '') {
      $selRes = Invoke-Alpha1NavSelect $uiaT.root $tgt
      Start-Sleep -Milliseconds 700
      $uiaBlock['navSelect'] = [ordered]@{ target = $tgt; result = $selRes }
      if ($selNav -ne '') { $uiaBlock['navRestore'] = [ordered]@{ target = $selNav; result = (Invoke-Alpha1NavSelect (Get-Alpha1UiaRoot $hwnd).root $selNav) } }
    }
  }
  $sampleT = Get-Alpha1Sample $hwnd $Alpha
  $smtcT = Get-Alpha1Smtc
  Rec 'p7-uia-under-transparent' ([ordered]@{ uia = $uiaBlock; sample = $sampleT; smtc = $smtcT; hung = [Alpha1Native]::IsHungAppWindow($hwnd) })
  $result['uiaOkWithTransparent'] = ([bool]$uiaT.ok -and [int]$uiaBlock.counts.descendants -gt 0 -and [bool]$uiaBlock.action.setFocusOk -and [bool]$uiaBlock.action.scrollIntoViewOk)
  $result['selectionPatternOkWithTransparent'] = [bool]($uiaBlock.navSelect -and $uiaBlock.navSelect.result.ok)
  $result['alphaHeldWithTransparent'] = ([string]$sampleT.classification -eq 'HELD')
  $result['playbackOkWithTransparent'] = ([string]$smtcT.status -eq 'Playing')

  # ---------------- P8: control - remove the style, Apple Music must block again ----------------
  $untrans = Remove-Alpha1Transparent $hwnd
  $controlHits = New-Object System.Collections.ArrayList
  foreach ($p in $subset) {
    $hit = Get-Alpha1PointHit $hwnd ([int]$p.x) ([int]$p.y)
    [void]$controlHits.Add([ordered]@{ region = $p.region; x = $p.x; y = $p.y; hitIsAppleMusic = $hit.isAppleMusic; hitClass = $hit.class })
  }
  $ctlAm = @($controlHits.ToArray() | Where-Object { $_.hitIsAppleMusic })
  $ctlPoint = $subset[0]
  $b4 = Get-Alpha1ReceiverCounts
  $ctlClick = Invoke-Alpha1RealClick ([int]$ctlPoint.x) ([int]$ctlPoint.y) -Button Left
  $af = Get-Alpha1ReceiverCounts
  $ctlDelivered = ([int]$af.left - [int]$b4.left)
  Rec 'p8-control' ([ordered]@{ removal = $untrans; hitAmPoints = $ctlAm.Count; ofPoints = $controlHits.Count; clickPoint = ('' + $ctlPoint.x + ',' + $ctlPoint.y); receiverDeltaOnClick = $ctlDelivered; hits = @($controlHits.ToArray()) })
  $result['removalRestoresBlocking'] = (($ctlAm.Count -eq $controlHits.Count) -and ($ctlDelivered -eq 0))
} finally {
  if ($receiver) { Close-Alpha1Receiver $receiver; $receiver = $null }
  $restoreRes = Restore-Alpha1 $hwnd $recipe -SkipMinimize
}

Rec 'p9-restore' $restoreRes
$result['restoredOriginalExStyle'] = [bool]$restoreRes.matchesOriginal
Start-Sleep -Milliseconds $SettleMs
$post = Get-Alpha1UiaRoot $hwnd
$postSample = Get-Alpha1Sample $hwnd 255
$postSmtc = Get-Alpha1Smtc
Rec 'p10-postrestore' ([ordered]@{ sample = $postSample; uia = [ordered]@{ ok = $post.ok; name = $post.name; counts = $(if ($post.ok) { Get-Alpha1UiaCounts $post.root } else { $null }) }; smtc = $postSmtc })
$result['uiaRecoveredAfterRestore'] = [bool]$post.ok
if ($recipe.preIconic) { $minRes = Set-Alpha1WindowMinimized $hwnd; Rec 'p11-minimize' $minRes } else { Rec 'p11-minimize' ([ordered]@{ skipped = 'window was not minimized before the experiment' }) }
if ($cursorStart) { try { [System.Windows.Forms.Cursor]::Position = $cursorStart } catch { } }

$pass = ([bool]$result['allPointsSkipAppleMusic'] -and [bool]$result['realMouseEventDelivered'] -and [bool]$result['uiaOkWithTransparent'])
$result['B_PLUS_PASS'] = $pass
$summary = [ordered]@{ stamp = $stamp; kind = 'click-through-sweep'; requestedAlpha = $Alpha; grid = $Grid; pass = $pass; result = $result; recipePath = $recipePath }
Rec 'summary' ([ordered]@{ pass = $pass; result = $result })

$repDir = Get-Alpha1ReportDir
$txtPath = Join-Path $repDir ($stamp + '-sweep.txt')
Set-Content -Path $txtPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
$jsonlPath = Join-Path $repDir ($stamp + '-sweep.jsonl')
Set-Content -Path $jsonlPath -Value (@($recs.ToArray() | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 }) -join [Environment]::NewLine) -Encoding UTF8
$sumPath = Join-Path $repDir ($stamp + '-sweep-summary.json')
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $sumPath -Encoding UTF8
Write-Host ''
Write-Host ('reports: ' + $txtPath)
Write-Host ('         ' + $jsonlPath)
Write-Host ('         ' + $sumPath)
Write-Host ''
Write-Host '=== B+ RESULT ==='
Write-Host ($result | ConvertTo-Json -Depth 6)