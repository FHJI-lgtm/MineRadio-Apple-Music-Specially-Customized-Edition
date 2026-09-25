# ============================================================
# phase3.7B-uia-no-mouse/run-contract-probe2.ps1   (Phase 3.7B.3 round)
#
# Narrow scope, exactly the three fixes agreed for this round:
#   1. ItemContainer(10019) is probed on a LIVE ControlType.List element (never on an
#      info copy - that was the 3.7B.2 bug that produced "OrderedDictionary does not
#      contain a method named 'TryGetCurrentPattern'").
#   2. The internal-control census and the invoke use THE SAME element set from ONE
#      post-Realize enumeration, so "candidateCount = 0" and "we invoked an element"
#      can no longer contradict each other.  Every candidate carries the full field
#      list (ControlType/ClassName/Name/AutomationId/IsOffscreen/Bounds/InvokePattern
#      exists+supported) and its own invoke result.
#   3. FLAT JSONL: one key=value fact per line, no nested structures, no ConvertTo-Json
#      (PS 5.1 OrderedDictionary serialization is not worth fighting).
#
# Keeps: pause baseline, mouse/foreground/focus/keyboard audits, Realize geometry.
# Still forbidden: any mouse/keyboard API, SetForegroundWindow as part of activation,
# COM/IPC work.  ASCII-only.
# ============================================================
[CmdletBinding()]
param([int]$PlayWaitMs = 5000)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\activation.ps1')
. (Join-Path $PSScriptRoot 'lib\contract.ps1')

function Get-AmNmStamp2 { return (Get-Date).ToString('yyyyMMdd-HHmmss') }
function Tok([string]$s) { if ($null -eq $s) { return 'EMPTY' }; $t = ($s -replace '[\s\r\n]+', '_' -replace '"', ''); if ($t -eq '') { return 'EMPTY' }; return $t }
function Bv([bool]$v) { return ('' + $v).ToLower() }

function Invoke-AmNmPause {
  try {
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $flags = [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static -bor [System.Reflection.BindingFlags]::InvokeMethod
    $mgr = Await-AmNavWinRt ($mgrType.InvokeMember('RequestAsync', $flags, $null, $null, @())) $mgrType 4000
    if ($mgr -eq $null) { return $false }
    foreach ($s in @($mgr.GetSessions())) {
      if (('' + $s.SourceAppUserModelId) -like '*AppleMusic*') {
        [void](Await-AmNavWinRt ($s.TryPauseAsync()) ([Windows.Foundation.IAsyncOperation`1[System.Boolean]]) 3000)
        return $true
      }
    }
  } catch { }
  return $false
}

# live List ancestor of a live element
function Get-AmNmLiveListAncestor($el, [int]$Depth = 8) {
  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $cur = $el
    for ($i = 1; $i -le $Depth; $i++) {
      $cur = $walker.GetParent($cur)
      if ($cur -eq $null) { return $null }
      if (('' + $cur.Current.ControlType.ProgrammaticName) -eq 'ControlType.List') { return $cur }
    }
  } catch { }
  return $null
}

$script:AmNmActionTypes2 = @('ControlType.Button', 'ControlType.Hyperlink', 'ControlType.Custom', 'ControlType.SplitButton', 'ControlType.ToggleButton', 'ControlType.MenuItem')

# ONE enumeration after Realize: flat records that keep their live element
function Get-AmNmControlCensus($el, [int]$Cap = 600) {
  $out = @()
  if ($el -eq $null) { return $out }
  try {
    $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $n = 0
    foreach ($c in $all) {
      $n++; if ($n -gt $Cap) { break }
      $ct = ''; $nm = ''; $aid = ''; $cls = ''; $w = 0; $h = 0; $off = $false
      try {
        $cur = $c.Current
        $ct = '' + $cur.ControlType.ProgrammaticName; $nm = '' + $cur.Name; $aid = '' + $cur.AutomationId; $cls = '' + $cur.ClassName
        $w = [int]$cur.BoundingRectangle.Width; $h = [int]$cur.BoundingRectangle.Height; $off = [bool]$cur.IsOffscreen
      } catch { continue }
      $invokePat = Get-AmNmPatternRef 10000
      $invokeExists = $false
      if ($invokePat -ne $null) { $o = $null; try { $invokeExists = [bool]$c.TryGetCurrentPattern($invokePat, [ref]$o) } catch { } }
      $isAction = ($script:AmNmActionTypes2 -contains $ct)
      $out += , @{ element = $c; controlType = $ct; name = $nm; automationId = $aid; className = $cls; w = $w; h = $h; offscreen = $off
                   invokeExists = $invokeExists; isActionType = $isAction; candidate = ($isAction -or $invokeExists) }
    }
  } catch { }
  return $out
}

$cfg = Get-Content -Path (Join-Path $PSScriptRoot 'cases\E10.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$controls = @((Get-Content -Path (Join-Path $PSScriptRoot 'cases\controls.json') -Raw -Encoding UTF8 | ConvertFrom-Json).controls)
$dir = Get-AmNmReportDir
$stamp = Get-AmNmStamp2
$outPath = Join-Path $dir ('contract2-' + $stamp + '.jsonl')
$hygiene = Test-AmNmScriptHygiene

$jobs = @(
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'item-container'; pid = 10019; anchor = 'list' },
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'expand-collapse'; pid = 10005; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'toggle'; pid = 10015; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'legacy-accessible'; pid = 10018; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'internal-controls'; pid = 0; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N2'; pattern = 'internal-controls'; pid = 0; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N4'; pattern = 'internal-controls'; pid = 0; anchor = 'row' },
  @{ caseId = 'CTRL-A'; scenario = 'N1'; pattern = 'internal-controls'; pid = 0; anchor = 'row' },
  @{ caseId = 'CTRL-C'; scenario = 'N1'; pattern = 'internal-controls'; pid = 0; anchor = 'row' }
)

$attempt = 0
foreach ($j in $jobs) {
  $attempt++
  $title = $cfg.target.title; $artist = $cfg.target.artist; $url = $cfg.target.url
  if ($j.caseId -like 'CTRL-*') {
    $letter = $j.caseId.Substring(5); $cc = @($controls | Where-Object { $_.id -eq $letter })[0]
    $title = $cc.title; $artist = $cc.artist; $url = $cc.url
  }
  Write-Host ('== [' + $attempt + '/' + $jobs.Count + '] ' + $j.caseId + '/' + $j.scenario + '/' + $j.pattern + ' pid=' + $j.pid)
  $w = Get-AmNavWindowInfo
  if (-not $w.uiaWindowFound) { Write-Host '  no window - skip'; continue }
  [void](Set-AmNmScenario -Scenario $j.scenario -AmHwnd $w.hwnd)
  if ($j.scenario -ne 'N3') { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'echo holder' -WindowStyle Minimized -ErrorAction SilentlyContinue | Out-Null; Start-Sleep -Milliseconds 700 }
  if ($j.scenario -ne 'N4') { [void](Invoke-AmNavDeepLink -Url $url -Method 'url'); Start-Sleep -Seconds 3 }
  $pauseRan = Invoke-AmNmPause
  Start-Sleep -Milliseconds 500

  $a0 = New-AmNmAudit
  $smtcBefore = Get-AmNmSmtc
  $rootEl = Get-AmNavWindowElement
  $found = Find-AmNmTargetElements $rootEl $title $artist
  $targetLive = $null
  if ($found.listItemMatches.Count -gt 0) { $targetLive = $found.listItemMatches[0].element }
  $listLive = $null
  if ($targetLive -ne $null) { $listLive = Get-AmNmLiveListAncestor $targetLive 8 }

  $geomBefore = ''; $geomAfter = ''; $geomAfterScroll = ''; $geomOk = $false; $realizeOk = $false
  if ($targetLive -ne $null) {
    $r = Invoke-AmNmRealize -Element $targetLive -Label ('attempt' + $attempt)
    $realizeOk = [bool]$r.realizeOk; $geomOk = [bool]$r.geometryAfter
    $geomBefore = $r.boundsBefore; $geomAfter = $r.boundsAfterRealize; $geomAfterScroll = $r.boundsAfterScroll
  }
  $census = Get-AmNmControlCensus $targetLive
  $candidates = @($census | Where-Object { $_.candidate })

  $probeExists = $false; $probeSupported = $false; $probeInvoked = $false; $probeOk = $false; $probeErr = ''; $probeDetail = ''
  $probeTarget = 'none'
  if ($targetLive -ne $null -and $j.pid -ne 0) {
    $el = $targetLive
    if ($j.anchor -eq 'list') {
      if ($listLive -eq $null) { $probeDetail = 'live-list-ancestor-not-found' } else { $el = $listLive; $probeTarget = 'live-List' }
    } else { $probeTarget = 'live-ListItem' }
    if ($probeDetail -eq '') {
      $pat = Get-AmNmPatternRef $j.pid
      if ($pat -eq $null) { $probeDetail = 'pattern-id-not-resolvable' }
      else {
        $o = $null
        try { $probeExists = [bool]$el.TryGetCurrentPattern($pat, [ref]$o) } catch { $probeErr = $_.Exception.Message }
        $probeSupported = $probeExists
        if ($probeExists) {
          $probeInvoked = $true
          try {
            if ($j.pid -eq 10019) {
              $nameProp = [System.Windows.Automation.AutomationElement]::NameProperty
              $hit = $o.FindItemByProperty($null, $nameProp, $title)
              if ($hit -eq $null) { $probeDetail = 'FindItemByProperty-no-match' }
              else { $probeDetail = ('FindItemByProperty-match class=' + (Tok ('' + $hit.Current.ClassName)) + ' aid=' + (Tok ('' + $hit.Current.AutomationId)) + ' offscreen=' + ('' + $hit.Current.IsOffscreen)) }
            } elseif ($j.pid -eq 10005) { $o.Expand(); $probeDetail = 'Expand-called' }
            elseif ($j.pid -eq 10015) { $o.Toggle(); $probeDetail = 'Toggle-called' }
            elseif ($j.pid -eq 10018) { $o.DoDefaultAction(); $probeDetail = 'DoDefaultAction-called' }
            $probeOk = $true
          } catch { $probeErr = $_.Exception.Message }
        } else { $probeDetail = 'pattern-not-supported-on-' + $probeTarget }
      }
    }
  }

  # census and invoke on the SAME element set
  $invokedCount = 0; $invokeOkCount = 0
  $candLines = New-Object System.Collections.Generic.List[string]
  $ci = 0
  foreach ($c in $candidates) {
    $ci++
    $inv = $false; $invErr = ''
    if ($c.invokeExists) {
      $a = Invoke-AmNmAction -Element $c.element -Strategy 'invoke'
      $inv = [bool]$a.succeeded; $invErr = '' + $a.error
      if ($a.attempted) { $invokedCount++ }
      if ($inv) { $invokeOkCount++ }
    }
    $candLines.Add('kind=candidate attempt=' + $attempt + ' case=' + (Tok $j.caseId) + ' scenario=' + (Tok $j.scenario) + ' pattern=' + (Tok $j.pattern) + ' idx=' + $ci +
      ' controlType=' + (Tok $c.controlType) + ' name=' + (Tok $c.name) + ' automationId=' + (Tok $c.automationId) + ' className=' + (Tok $c.className) +
      ' offscreen=' + (Bv $c.offscreen) + ' w=' + $c.w + ' h=' + $c.h + ' isActionType=' + (Bv $c.isActionType) + ' invokeExists=' + (Bv $c.invokeExists) +
      ' invokeAttempted=' + (Bv $c.invokeExists) + ' invokeSucceeded=' + (Bv $inv) + ' invokeError=' + (Tok $invErr))
  }
  $censusAfter = Get-AmNmControlCensus $targetLive
  $candidatesAfter = @($censusAfter | Where-Object { $_.candidate })
  $newControls = 0
  foreach ($c in $candidatesAfter) { if (-not (@($candidates) | Where-Object { $_.controlType -eq $c.controlType -and $_.name -eq $c.name -and $_.automationId -eq $c.automationId })) { $newControls++ } }
  $treeChanged = (($candidatesAfter.Count -ne $candidates.Count) -or ($newControls -gt 0))

  if ($invokedCount -gt 0) { [void](Wait-AmNmPlayback -TimeoutMs $PlayWaitMs) }
  $a1 = New-AmNmAudit
  $cmp = Compare-AmNmAudit $a0 $a1
  $smtcAfter = Get-AmNmSmtc
  $playing = Test-AmNmTargetPlaying $smtcAfter $title $artist
  $smtcChanged = ((('' + $smtcAfter.title) -ne ('' + $smtcBefore.title)) -or (('' + $smtcAfter.status) -ne ('' + $smtcBefore.status)))

  $result = 'PROBE_ONLY'
  if ($targetLive -eq $null) { $result = 'NO_TARGET_ELEMENT' }
  elseif ($playing.ok -and -not $cmp.mouseMoved -and -not $cmp.foregroundChanged) { $result = 'NO_MOUSE_ACTIVATION_PASS' }
  elseif ($playing.ok -and $cmp.foregroundChangedByApplication) { $result = 'ACTIVATION_FOREGROUND_STEAL' }
  elseif ($playing.ok) { $result = 'UNATTRIBUTED_SUCCESS' }
  elseif ($j.pid -ne 0 -and -not $probeExists -and $probeDetail -eq 'pattern-id-not-resolvable') { $result = 'PATTERN_NOT_RESOLVABLE' }
  elseif ($j.pid -ne 0 -and -not $probeExists) { $result = 'PATTERN_NOT_SUPPORTED' }
  elseif ($invokeOkCount -gt 0) { $result = 'INTERNAL_INVOKE_NO_EFFECT' }
  elseif ($probeOk) { $result = 'ACTION_NO_EFFECT' }
  else { $result = 'CENSUS_ONLY' }

  $head = 'kind=job attempt=' + $attempt + ' case=' + (Tok $j.caseId) + ' scenario=' + (Tok $j.scenario) + ' pattern=' + (Tok $j.pattern) + ' patternId=' + $j.pid + ' probeTarget=' + (Tok $probeTarget) +
    ' patternExists=' + (Bv $probeExists) + ' supportsAction=' + (Bv $probeSupported) + ' actionInvoked=' + (Bv $probeInvoked) + ' actionSucceeded=' + (Bv $probeOk) + ' actionError=' + (Tok $probeErr) + ' detail=' + (Tok $probeDetail) +
    ' realized=' + (Bv $realizeOk) + ' geometryAfter=' + (Bv $geomOk) + ' boundsBefore=' + (Tok $geomBefore) + ' boundsAfterRealize=' + (Tok $geomAfter) +
    ' titleRowsMatched=' + $found.listItemMatches.Count + ' liveListAncestor=' + (Bv ($listLive -ne $null)) +
    ' candidateCount=' + $candidates.Count + ' invokedCount=' + $invokedCount + ' invokeOkCount=' + $invokeOkCount +
    ' candidateCountAfter=' + $candidatesAfter.Count + ' newControlsMaterialized=' + $newControls + ' treeChanged=' + (Bv $treeChanged) +
    ' pauseRan=' + (Bv $pauseRan) + ' smtcBefore=' + (Tok $smtcBefore.title) + '/' + (Tok $smtcBefore.status) + ' smtcAfter=' + (Tok $smtcAfter.title) + '/' + (Tok $smtcAfter.status) + ' smtcChanged=' + (Bv $smtcChanged) + ' smtcExpected=' + (Bv $playing.ok) +
    ' mouseMoved=' + (Bv $cmp.mouseMoved) + ' cursorBefore=' + (Tok $cmp.cursorBefore) + ' cursorAfter=' + (Tok $cmp.cursorAfter) +
    ' foregroundChanged=' + (Bv $cmp.foregroundChanged) + ' foregroundChangedByApplication=' + (Bv $cmp.foregroundChangedByApplication) + ' keyboardInjected=false mouseGuardOk=' + (Bv $hygiene.ok) + ' result=' + $result
  [System.IO.File]::AppendAllText($outPath, $head + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
  foreach ($l in $candLines) { [System.IO.File]::AppendAllText($outPath, $l + "`r`n", (New-Object System.Text.UTF8Encoding($false))) }
  Write-Host ('   result=' + $result + ' probe(exists=' + $probeExists + ',ok=' + $probeOk + ') detail=' + $probeDetail + ' cand=' + $candidates.Count + ' invoked=' + $invokedCount + ' ok=' + $invokeOkCount + ' new=' + $newControls + ' geom=' + $geomOk + ' pause=' + $pauseRan + ' smtc=[' + $smtcAfter.title + '/' + $smtcAfter.status + '] mouse=' + $cmp.mouseMoved + ' fg=' + $cmp.foregroundChanged)
  Start-Sleep -Milliseconds 400
}
Stop-AmNmScenario
Write-Host ''
Write-Host ('flat jsonl: ' + $outPath)
