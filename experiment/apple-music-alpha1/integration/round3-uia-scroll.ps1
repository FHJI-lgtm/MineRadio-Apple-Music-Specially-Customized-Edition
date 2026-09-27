# ============================================================
# experiment/apple-music-alpha1/integration/round3-uia-scroll.ps1
# Round 3: can UIA still SCROLL Apple Music while the window is at Alpha=1 + WS_EX_TRANSPARENT,
# and does MineRadio's lyric stage stay untouched?
#
# Rules honoured here:
#   * the stealth state is entered once and NEVER left during the scroll tests
#   * scrolling is UIA-only (ScrollPattern / ScrollItemPattern). The frozen Scroll-AmView helper
#     is mouse-wheel based and is deliberately NOT used (it would scroll the window below AM).
#   * the frozen Realize-AmRow helper (ScrollItemPattern.ScrollIntoView) IS reused.
#   * nothing in MineRadio is modified; its lyric state is read through Chromium DevTools
#     (a launch flag), which is the app's own existing debugging surface.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [string]$OutDir = 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration',
  [string]$Probe = 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration\cdp-lyrics-probe.js',
  [int]$Alpha = 1,
  [int]$NavTargetIndex = 7
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
function Get-MineRadioState([string]$Tag) {
  $file = Join-Path $OutDir ('cdp-' + $Tag + '.json')
  $null = & node $Probe snapshot $file 2>&1
  $info = [ordered]@{ file = $file; pages = 0; containers = 0; fingerprint = ''; error = '' }
  try {
    $j = Get-Content $file -Raw | ConvertFrom-Json
    $parts = New-Object System.Collections.ArrayList
    foreach ($pg in @($j.pages)) {
      $s = $pg.snapshot
      foreach ($c in @($s.containers)) { [void]$parts.Add(($s.page + '|' + $c.id + '|' + $c.cls + '|' + $c.scrollTop + '|' + $c.transform)) }
      [void]$parts.Add('lyric:' + (($s.lyric | ConvertTo-Json -Compress)))
      $info.containers = $info.containers + [int]$s.containerCount
    }
    $info.pages = @($j.pages).Count
    $info.fingerprint = (@($parts.ToArray()) -join ' ;; ')
  } catch { $info.error = $_.Exception.Message }
  return $info
}
function Get-TargetInfo($Target) {
  if (-not $Target) { return [ordered]@{ ok = $false } }
  $st = Get-Alpha1ScrollState $Target.element
  return [ordered]@{ ok = $true; name = $Target.name; automationId = $Target.automationId; controlType = $Target.controlType
    runtimeId = $Target.runtimeId; area = $Target.area; state = $st }
}

# ---------------- setup ----------------
$sel0 = Select-Alpha1Target
if (-not $sel0.selected) { Write-Host 'FATAL: no Apple Music window'; exit 3 }
$preIconic = [bool]$sel0.selected.iconic
$origEx = [int64][Alpha1Native]::ExStyle([IntPtr][int64]$sel0.selected.hwnd)
$frozen = Restore-AmWindow ([IntPtr][int64]$sel0.selected.hwnd)
Start-Sleep -Milliseconds 900
$sel = Select-Alpha1Target
$script:hwnd = [IntPtr][int64]$sel.selected.hwnd
$recipe = [ordered]@{ stamp = (Get-Alpha1Stamp); kind = 'round3-uia-scroll'; hwnd = [int64]$script:hwnd
  originalExStyle = [int64][Alpha1Native]::ExStyle($script:hwnd); originalStyle = [int64][Alpha1Native]::Style($script:hwnd)
  originalLayered = [bool][Alpha1Native]::IsLayered($script:hwnd); originalAlpha = [int][Alpha1Native]::ReadAlpha($script:hwnd)
  preIconic = $preIconic; addedLayered = $false; addedTransparent = $false; requestedAlpha = $Alpha }
Write-Alpha1Recipe $recipe.stamp $recipe | Out-Null
Rec 'setup' ([ordered]@{ hwnd = [int64]$script:hwnd; originalExStyle = ('0x' + ('{0:X8}' -f $origEx)); preIconic = $preIconic; frozenRestore = $frozen })

# optional: open MineRadio's own lyric stage through its own toggle so it can be watched
$null = & node $Probe open-lyrics (Join-Path $OutDir 'cdp-open-lyrics.json') 2>&1
Start-Sleep -Seconds 3
$mrPre = Get-MineRadioState 'round3-pre'
Rec 'mineradio-pre' ([ordered]@{ pages = $mrPre.pages; containers = $mrPre.containers; fingerprint = $mrPre.fingerprint; error = $mrPre.error })

$smtcBefore = Get-AmSmtcState
$scrollResult = [ordered]@{}
$restoreRes = $null
try {
  # ---------------- read-only recon of scrollable UIA elements (before stealth) ----------------
  $uia0 = Get-Alpha1UiaRoot $script:hwnd
  $targets0 = @()
  if ($uia0.ok) { $targets0 = @(Get-Alpha1ScrollTargets $uia0.root) }
  Rec 'recon-scroll-targets' ([ordered]@{ uiaRootOk = $uia0.ok; count = $targets0.Count
    targets = @($targets0 | ForEach-Object { [ordered]@{ name = $_.name; id = $_.automationId; type = $_.controlType; vScrollable = $_.verticallyScrollable; vPercent = $_.verticalPercent; viewSize = $_.verticalViewSize; area = $_.area } }) })

  # ---------------- enter the final stealth state and stay there ----------------
  $apply = Apply-Alpha1 $script:hwnd $Alpha
  $recipe['addedLayered'] = [bool]$apply.addedLayered
  $trans = Add-Alpha1Transparent $script:hwnd
  $recipe['addedTransparent'] = $true
  Write-Alpha1Recipe $recipe.stamp $recipe | Out-Null
  $stealthSample = Get-Alpha1Sample $script:hwnd $Alpha
  Rec 'stealth-on' ([ordered]@{ apply = $apply; transparent = $trans; sample = $stealthSample })

  # ---------------- make sure a genuinely scrollable region exists ----------------
  # On a page whose lists fit the window every ScrollViewer reports verticallyScrollable=false
  # (verticalPercent -1). Open a list page first, using the app's own sidebar selection
  # (SelectionItemPattern.Select - navigation only, no playback path is involved).
  $navRec = [ordered]@{ needed = $false; target = ''; result = $null }
  $uiaPre = Get-Alpha1UiaRoot $script:hwnd
  if ($uiaPre.ok) {
    $pre = @(Get-Alpha1ScrollTargets $uiaPre.root)
    if (@($pre | Where-Object { $_.verticallyScrollable -eq $true }).Count -eq 0) {
      $navRec.needed = $true
      $navItems = @(Get-Alpha1NavItems $uiaPre.root)
      $pick = $null
      if ($NavTargetIndex -ge 0 -and $NavTargetIndex -lt $navItems.Count) { $pick = $navItems[$NavTargetIndex] }
      if (-not $pick) { foreach ($nv in $navItems) { if ($nv.enabled -and ([string]$nv.name) -ne '') { $pick = $nv; break } } }
      if ($pick) {
        $navRec.target = [string]$pick.name
        $navRec.result = Invoke-Alpha1NavSelect $uiaPre.root ([string]$pick.name)
        Start-Sleep -Seconds 2
        $navRec.after = @(Get-Alpha1ScrollTargets (Get-Alpha1UiaRoot $script:hwnd).root | ForEach-Object { [ordered]@{ id = $_.automationId; vScrollable = $_.verticallyScrollable; vPercent = $_.verticalPercent; area = $_.area } })
      }
    }
  }
  Rec 'ensure-scrollable' $navRec

  # ---------------- pick the scroll target ----------------
  $uia1 = Get-Alpha1UiaRoot $script:hwnd
  $targets = @()
  if ($uia1.ok) { $targets = @(Get-Alpha1ScrollTargets $uia1.root) }
  $vTargets = @($targets | Where-Object { $_.verticallyScrollable -eq $true })
  $target = $null
  $scrollableAvailable = ($vTargets.Count -gt 0)
  if ($scrollableAvailable) { $target = $vTargets | Sort-Object -Property area -Descending | Select-Object -First 1 }
  elseif ($targets.Count -gt 0) { $target = $targets | Sort-Object -Property area -Descending | Select-Object -First 1 }
  $treeSig = ''
  $counts = $null
  if ($uia1.ok) { $counts = Get-Alpha1UiaCounts $uia1.root; try { $treeSig = Get-AmTreeSignature $uia1.root } catch { } }
  $scrollResult['targetFound'] = [bool]($target -ne $null)
  Rec 'baseline' ([ordered]@{ sample = (Get-Alpha1Sample $script:hwnd $Alpha); uiaRootOk = $uia1.ok; counts = $counts; treeSignature = $treeSig
    scrollTargets = $targets.Count; verticallyScrollable = $vTargets.Count; target = (Get-TargetInfo $target); mineradio = $mrPre.fingerprint })

  # ---------------- B/C/D: UIA scroll sequence (down, down, up, up) ----------------
  $opResults = New-Object System.Collections.ArrayList
  $mrFingerprints = New-Object System.Collections.ArrayList
  $dirs = @()
  if ($scrollableAvailable) { $dirs = @('down', 'down', 'up', 'up') } else { Rec 'scrollpattern-na' ([ordered]@{ reason = 'no element reports verticallyScrollable=true after navigation'; targets = @($targets | ForEach-Object { $_.automationId + ':' + $_.verticallyScrollable }) }) }
  $i = 0
  foreach ($d in $dirs) {
    $i++
    $beforeState = Get-Alpha1ScrollState $target.element
    $op = Invoke-Alpha1ScrollEx $target.element $d 'small'
    Start-Sleep -Milliseconds 500
    $mr = Get-MineRadioState ('round3-op' + $i)
    $uiaOp = Get-Alpha1UiaRoot $script:hwnd
    $sigOp = ''
    if ($uiaOp.ok) { try { $sigOp = Get-AmTreeSignature $uiaOp.root } catch { } }
    $sample = Get-Alpha1Sample $script:hwnd $Alpha
    $rec = [ordered]@{ step = ('scroll-' + $i + '-' + $d); direction = $d; op = $op; beforeState = $beforeState; afterState = (Get-Alpha1ScrollState $target.element)
      treeSignature = $sigOp; treeSignatureChanged = ($sigOp -ne $treeSig); alpha = $sample.observedAlpha; exStyle = $sample.exStyle; layered = $sample.layered; transparent = $sample.transparent
      mineradio = $mr.fingerprint; mineradioMatchesPre = ($mr.fingerprint -eq $mrPre.fingerprint) }
    [void]$opResults.Add($rec)
    [void]$mrFingerprints.Add([bool]$rec.mineradioMatchesPre)
    Rec $rec.step $rec
    $treeSig = $sigOp
  }

  # ---------------- frozen Realize-AmRow (ScrollItemPattern.ScrollIntoView) ----------------
  $rowRes = [ordered]@{ ok = $false; detail = '' }
  $uia2 = Get-Alpha1UiaRoot $script:hwnd
  if ($uia2.ok) {
    $items = Get-AmListItems $uia2.root
    $realized = @($items | Where-Object { $_ } | Select-Object -First 1)
    $el = $null
    if ($realized.Count -gt 0) {
      # Get-AmListItems may return elements directly or wrappers; accept both shapes
      $el = $realized[0]
      try { $null = $el.Current } catch { try { $el = $realized[0].element } catch { $el = $null } }
      try { $null = $el.Current } catch { $el = $null }
    }
    if ($el) {
      $stepsRow = Realize-AmRow $el 2500 120 $script:hwnd
      $rowRes = [ordered]@{ ok = $true; element = ('' + $el.Current.Name); detail = $stepsRow }
    } else { $rowRes = [ordered]@{ ok = $false; detail = 'no list item found' } }
  }
  $mrAfterRow = Get-MineRadioState 'round3-after-row'
  Rec 'scrollitem-realize' ([ordered]@{ realize = $rowRes; mineradio = $mrAfterRow.fingerprint; mineradioMatchesPre = ($mrAfterRow.fingerprint -eq $mrPre.fingerprint); sample = (Get-Alpha1Sample $script:hwnd $Alpha) })

  # ---------------- failure injection: scroll a bogus UIA target ----------------
  $bogus = $null
  try { $bogus = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]0x5EED5EED) } catch { $bogus = $null }
  $bogusRec = [ordered]@{ elementIsNull = ($null -eq $bogus); result = $null }
  $bogusRec.result = Invoke-Alpha1ScrollEx $bogus 'down' 'small'
  Rec 'failure-injection' $bogusRec
} finally {
  $restoreRes = Restore-Alpha1 $script:hwnd $recipe -SkipMinimize
}

$finalSample = Get-Alpha1Sample $script:hwnd 255
$smtcAfter = Get-AmSmtcState
if ($recipe.preIconic) { $min = Set-Alpha1WindowMinimized $script:hwnd; $minimized = $min.minimized } else { $minimized = [bool]$finalSample.iconic }
$gitDiff = (& git -C $repo diff --stat -- experiment/apple-music-windows-control/poc/lib | Out-String).Trim()
$mrPost = Get-MineRadioState 'round3-post'
Rec 'restore' ([ordered]@{ restore = $restoreRes; finalSample = $finalSample; minimized = $minimized; preIconic = $preIconic
  smtcBefore = [ordered]@{ title = $smtcBefore.title; status = $smtcBefore.status }; smtcAfter = [ordered]@{ title = $smtcAfter.title; status = $smtcAfter.status }
  pocLibDiff = $gitDiff; mineradioPost = $mrPost.fingerprint; mineradioMatchesPre = ($mrPost.fingerprint -eq $mrPre.fingerprint) })

Close-Alpha1Receiver $null | Out-Null
$samples = @($steps.ToArray() | Where-Object { $_.sample })
$alphaValues = @($samples | ForEach-Object { $_.sample.observedAlpha })
$transValues = @($samples | ForEach-Object { $_.sample.transparent })
$opOk = @($opResults.ToArray() | Where-Object { $_.op.ok })
$amMoved = @($opResults.ToArray() | Where-Object { $_.afterState.verticalPercent -ne $_.beforeState.verticalPercent -or $_.treeSignatureChanged })
$mrSideEffects = @($opResults.ToArray() | Where-Object { -not $_.mineradioMatchesPre })
$checklist = [ordered]@{
  stealthStateEntered = ([bool]$trans.ok -and $stealthSample.observedAlpha -eq $Alpha)
  uiaRootOk = [bool]$uia1.ok
  scrollTargetFound = [bool]($target -ne $null)
  scrollOpsAttempted = $opResults.Count
  scrollOpsOk = $opOk.Count
  appleMusicScrolled = ($amMoved.Count -gt 0)
  alphaAlwaysOne = (@($alphaValues | Where-Object { $_ -ne $Alpha }).Count -eq 0)
  transparentAlwaysOn = (@($transValues | Where-Object { $_ -ne $true }).Count -eq 0)
  scrollPatternApplicable = $scrollableAvailable
  mineradioSideEffects = $mrSideEffects.Count
  transportUntouched = ([string]$smtcBefore.title -eq [string]$smtcAfter.title -and [string]$smtcBefore.status -eq [string]$smtcAfter.status)
  pocLibClean = ([string]::IsNullOrWhiteSpace($gitDiff))
  failureInjectionCaught = ([bool](@($steps.ToArray() | Where-Object { $_.step -eq 'failure-injection' })[0].result.ok) -eq $false)
  finallyRestored = [bool]$restoreRes.matchesOriginal
  alphaBackTo255 = ($finalSample.observedAlpha -in @(255, -1))
  stylesCleared = (-not $finalSample.layered -and -not $finalSample.transparent)
  iconicMatchesPre = ([bool](Get-Alpha1Sample $script:hwnd 255).iconic -eq $preIconic)
}
$summary = [ordered]@{ at = (Get-Alpha1Iso); kind = 'round3-uia-scroll'; recipe = $recipe; checklist = $checklist; steps = @($steps.ToArray()) }
$sumFile = Join-Path $OutDir 'round3-uia-scroll-summary.json'
$summary | ConvertTo-Json -Depth 10 | Set-Content -Path $sumFile -Encoding UTF8
Write-Host ''
Write-Host '=== ROUND 3 CHECKLIST ==='
Write-Host ($checklist | ConvertTo-Json -Depth 4)
Write-Host ('summary: ' + $sumFile)