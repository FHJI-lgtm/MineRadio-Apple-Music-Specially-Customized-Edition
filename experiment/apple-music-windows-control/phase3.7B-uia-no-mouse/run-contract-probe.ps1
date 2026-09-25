# ============================================================
# phase3.7B-uia-no-mouse/run-contract-probe.ps1   (Phase 3.7B.2 round)
#
# Strict causal isolation for the REMAINING UIA contracts.  For every pattern the
# record carries the full causal chain, never just "supported = true":
#   patternExists / supportsAction / actionInvoked / actionSucceeded
#   treeChanged / newControlsMaterialized / geometryChanged / SMTCChanged / SMTCExpected
#
# It also tests the hypothesis that the row itself is not the play entry point:
#   ListItem.Realize -> an inner playback control materialises -> that control.Invoke()
#
# Local subtree snapshots are taken BEFORE the action, AFTER realize and AFTER the
# action, then diffed for Button / Hyperlink / Custom / SplitButton / ToggleButton and
# for elements carrying InvokePattern / TogglePattern / SelectionItemPattern.
#
# Fixes the runner-side bug: Invoke-AmNmPause is now implemented (TryPauseAsync +
# Await-AmNavWinRt) so a "Paused" baseline can no longer hide a pause that never ran.
#
# Hard rules kept: no mouse API, no SetForegroundWindow, no keyboard input.
# ASCII-only.  Output: reports/contract-<stamp>.jsonl (hand-built JSONL - ConvertTo-Json
# is avoided for nested structures on this PS 5.1 build).
# ============================================================
[CmdletBinding()]
param([int]$PlayWaitMs = 5000, [switch]$AllScenarios)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\activation.ps1')
. (Join-Path $PSScriptRoot 'lib\contract.ps1')

function Get-AmNmStamp { return (Get-Date).ToString('yyyyMMdd-HHmmss') }
function Get-AmNmIso { return (Get-Date).ToString('s') }
function Esc([string]$s) { if ($null -eq $s) { return '' }; return ($s -replace '\\', '/' -replace '"', "'" -replace "`r", ' ' -replace "`n", ' ') }
function B([bool]$v) { return ('' + $v).ToLower() }

# ---- the missing helper, implemented (runner-side bug from 3.7B.1) -----------
function Invoke-AmNmPause {
  try {
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $flags = [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static -bor [System.Reflection.BindingFlags]::InvokeMethod
    $op = $mgrType.InvokeMember('RequestAsync', $flags, $null, $null, @())
    $mgr = Await-AmNavWinRt $op $mgrType 4000
    if ($mgr -eq $null) { return $false }
    foreach ($s in @($mgr.GetSessions())) {
      if (('' + $s.SourceAppUserModelId) -like '*AppleMusic*') {
        $bType = [Windows.Foundation.IAsyncOperation`1[System.Boolean]]
        [void](Await-AmNavWinRt ($s.TryPauseAsync()) $bType 3000)
        return $true
      }
    }
  } catch { }
  return $false
}

$script:AmNmActionControlTypes = @('ControlType.Button', 'ControlType.Hyperlink', 'ControlType.Custom', 'ControlType.SplitButton', 'ControlType.ToggleButton', 'ControlType.MenuItem')

function Get-AmNmSubtree($el, [int]$Cap = 400) {
  $out = @()
  if ($el -eq $null) { return $out }
  try {
    $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $n = 0
    foreach ($c in $all) {
      $n++; if ($n -gt $Cap) { break }
      $ct = ''; $nm = ''; $aid = ''; $cls = ''; $w = 0; $h = 0
      try {
        $cur = $c.Current
        $ct = '' + $cur.ControlType.ProgrammaticName; $nm = '' + $cur.Name
        $aid = '' + $cur.AutomationId; $cls = '' + $cur.ClassName
        $w = [int]$cur.BoundingRectangle.Width; $h = [int]$cur.BoundingRectangle.Height
      } catch { continue }
      $pats = @()
      foreach ($pid in @(10000, 10015, 10010, 10005, 10017, 10020)) {
        $pat = Get-AmNmPatternRef $pid
        if ($pat -ne $null) { $o = $null; try { if ($c.TryGetCurrentPattern($pat, [ref]$o)) { $pats += $pid } } catch { } }
      }
      $out += , [ordered]@{ controlType = $ct; name = $nm; automationId = $aid; className = $cls; w = $w; h = $h; patterns = ($pats -join ',') }
    }
  } catch { }
  return $out
}

function Compare-AmNmSubtree($before, $after) {
  $bk = @{}
  foreach ($b in $before) { $bk[('' + $b.controlType + '|' + $b.name + '|' + $b.automationId)] = $b }
  $new = @(); $geomChanged = 0
  foreach ($a in $after) {
    $k = ('' + $a.controlType + '|' + $a.name + '|' + $a.automationId)
    if (-not $bk.ContainsKey($k)) { $new += , $a }
    else { $b = $bk[$k]; if (($b.w -ne $a.w) -or ($b.h -ne $a.h)) { $geomChanged++ } }
  }
  return @{ beforeCount = $before.Count; afterCount = $after.Count; treeChanged = (($before.Count -ne $after.Count) -or ($new.Count -gt 0))
            newControls = $new; newControlCount = $new.Count; geometryChanged = $geomChanged }
}

$cfg = Get-Content -Path (Join-Path $PSScriptRoot 'cases\E10.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$controls = @((Get-Content -Path (Join-Path $PSScriptRoot 'cases\controls.json') -Raw -Encoding UTF8 | ConvertFrom-Json).controls)
$dir = Get-AmNmReportDir
$stamp = Get-AmNmStamp
$jsonlPath = Join-Path $dir ('contract-' + $stamp + '.jsonl')

$hygiene = Test-AmNmScriptHygiene
Write-Host ('MouseGuard (static): ok=' + $hygiene.ok + ' scanned=' + $hygiene.scanned + ' hits=[' + ($hygiene.hits -join '; ') + ']')

$jobs = @(
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'item-container'; pid = 10019; anchor = 'list' },
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'expand-collapse'; pid = 10005; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'toggle'; pid = 10015; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'legacy-accessible'; pid = 10018; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N1'; pattern = 'internal-control-invoke'; pid = 0; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N2'; pattern = 'internal-control-invoke'; pid = 0; anchor = 'row' },
  @{ caseId = 'E10'; scenario = 'N4'; pattern = 'internal-control-invoke'; pid = 0; anchor = 'row' },
  @{ caseId = 'CTRL-A'; scenario = 'N1'; pattern = 'internal-control-invoke'; pid = 0; anchor = 'row' },
  @{ caseId = 'CTRL-C'; scenario = 'N1'; pattern = 'internal-control-invoke'; pid = 0; anchor = 'row' }
)
if ($AllScenarios) {
  foreach ($sc in @('N3')) { $jobs += , @{ caseId = 'E10'; scenario = $sc; pattern = 'internal-control-invoke'; pid = 0; anchor = 'row' } }
}

$attempt = 0
foreach ($j in $jobs) {
  $attempt++
  $title = $cfg.target.title; $artist = $cfg.target.artist; $url = $cfg.target.url
  if ($j.caseId -like 'CTRL-*') {
    $letter = $j.caseId.Substring(5)
    $cc = @($controls | Where-Object { $_.id -eq $letter })[0]
    $title = $cc.title; $artist = $cc.artist; $url = $cc.url
  }
  $id = ($j.caseId + '/' + $j.scenario + '/' + $j.pattern)
  Write-Host ('== [' + $attempt + '/' + $jobs.Count + '] ' + $id)
  $w = Get-AmNavWindowInfo
  if (-not $w.uiaWindowFound) { Write-Host '  window missing - skip'; continue }
  $setupLog = @(Set-AmNmScenario -Scenario $j.scenario -AmHwnd $w.hwnd)
  if ($j.scenario -ne 'N3') { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'echo holder' -WindowStyle Minimized -ErrorAction SilentlyContinue | Out-Null; Start-Sleep -Milliseconds 700 }
  if ($j.scenario -ne 'N4') { [void](Invoke-AmNavDeepLink -Url $url -Method 'url'); Start-Sleep -Seconds 3 }
  $pauseRan = Invoke-AmNmPause
  Start-Sleep -Milliseconds 500

  $auditBefore = New-AmNmAudit
  $rootEl = Get-AmNavWindowElement
  $smtcBefore = Get-AmNmSmtc
  $rowAnalysis = Get-AmNmRowAnalysis $rootEl $title $artist
  $found = Find-AmNmTargetElements $rootEl $title $artist
  $target = $null
  if ($found.listItemMatches.Count -gt 0) {
    $geom = @($rowAnalysis.rows | Where-Object { $_.boundsWidth -gt 0 })
    $ord = 1; if ($geom.Count -gt 0) { $ord = $geom[0].ordinal }
    if ($found.listItemMatches.Count -ge $ord) { $target = $found.listItemMatches[$ord - 1].element }
  }
  $listEl = $null
  if ($target -ne $null) {
    $chain = Get-AmNmAnchorChain $target 5
    foreach ($a in $chain) { if ($a.controlType -eq 'ControlType.List') { $listEl = $a; break } }
  }

  # ---- before / after realize / after action snapshots of the local subtree ----
  $snapBefore = Get-AmNmSubtree $target
  $realize = $null
  if ($target -ne $null) { $realize = Invoke-AmNmRealize -Element $target -Label $id }
  $snapAfterRealize = Get-AmNmSubtree $target
  $diffRealize = Compare-AmNmSubtree $snapBefore $snapAfterRealize

  $probe = [ordered]@{ patternId = $j.pid; patternName = $j.pattern; patternExists = $false; supportsAction = $false
                       actionInvoked = $false; actionSucceeded = $false; actionError = ''
                       treeChanged = $false; newControlsMaterialized = 0; geometryChanged = 0
                       smtcChanged = $false; smtcExpected = $false; detail = '' }
  $internalInvoke = [ordered]@{ attempted = $false; candidateCount = 0; candidate = ''; candidatePatterns = ''
                                invoked = $false; error = '' }

  if ($target -ne $null -and $j.pid -ne 0) {
    $el = $target
    if ($j.anchor -eq 'list' -and $listEl -ne $null) { $el = $listEl }
    if ($j.anchor -eq 'list' -and $listEl -eq $null) { $probe.detail = 'anchor-list-not-found' }
    $pat = Get-AmNmPatternRef $j.pid
    if ($pat -eq $null) { $probe.detail = 'pattern-id-not-resolvable-on-this-machine' }
    else {
      $obj = $null
      $ok = $false
      try { $ok = $el.TryGetCurrentPattern($pat, [ref]$obj) } catch { $probe.actionError = $_.Exception.Message }
      $probe.patternExists = [bool]$ok
      $probe.supportsAction = [bool]$ok
      if ($ok) {
        $probe.actionInvoked = $true
        try {
          if ($j.pid -eq 10019) {
            $nameProp = [System.Windows.Automation.AutomationElement]::NameProperty
            $hit = $obj.FindItemByProperty($null, $nameProp, $title)
            if ($hit -eq $null) { $probe.detail = 'FindItemByProperty: no match' }
            else { $probe.detail = ('FindItemByProperty: match class=' + $hit.Current.ClassName + ' aid=' + $hit.Current.AutomationId) }
          } elseif ($j.pid -eq 10005) { $obj.Expand() }
          elseif ($j.pid -eq 10015) { $obj.Toggle() }
          elseif ($j.pid -eq 10018) { $obj.DoDefaultAction() }
          $probe.actionSucceeded = $true
        } catch { $probe.actionError = $_.Exception.Message }
      }
    }
    $wait = Wait-AmNmPlayback -TimeoutMs $PlayWaitMs
  }

  # ---- the key hypothesis: realize -> inner playback control -> that control's Invoke
  $snapAfterAction = Get-AmNmSubtree $target
  $diffAction = Compare-AmNmSubtree $snapAfterRealize $snapAfterAction
  $probe.treeChanged = ($diffAction.treeChanged -or $diffRealize.treeChanged)
  $probe.newControlsMaterialized = ($diffAction.newControlCount + $diffRealize.newControlCount)
  $probe.geometryChanged = ($diffAction.geometryChanged + $diffRealize.geometryChanged)

  $internalCandidates = @()
  foreach ($c in $snapAfterRealize) {
    $isActionType = ($script:AmNmActionControlTypes -contains $c.controlType)
    $hasInvoke = (('' + $c.patterns).Split(',') -contains '10000')
    if ($isActionType -or $hasInvoke) { $internalCandidates += , $c }
  }
  $internalInvoke.candidateCount = $internalCandidates.Count
  if ($internalCandidates.Count -gt 0) { $internalInvoke.candidate = ('' + $internalCandidates[0].controlType + '[' + $internalCandidates[0].name + ']'); $internalInvoke.candidatePatterns = ('' + $internalCandidates[0].patterns) }

  if ($j.pattern -eq 'internal-control-invoke' -and $target -ne $null) {
    $inner = $null
    if ($listEl -ne $null) {
      foreach ($a in $internalCandidates) {
        # re-find the element by walking the row subtree and matching control type + name
        try {
          $pat2 = Get-AmNmPatternRef 10000
          if ($pat2 -eq $null) { break }
          $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
          $btn = $target.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
          if ($btn -ne $null) { $inner = $btn; break }
        } catch { }
      }
    }
    if ($inner -eq $null) {
      try {
        $condAny = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
        $all = $target.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condAny)
        foreach ($c in $all) {
          $ct = '' + $c.Current.ControlType.ProgrammaticName
          if ($script:AmNmActionControlTypes -contains $ct) { $inner = $c; break }
        }
      } catch { }
    }
    if ($inner -ne $null) {
      $internalInvoke.attempted = $true
      $a = Invoke-AmNmAction -Element $inner -Strategy 'invoke'
      $internalInvoke.invoked = $a.succeeded
      $internalInvoke.error = $a.error
      if (-not $a.supported) { $internalInvoke.error = 'inner-element-has-no-invoke-pattern' }
      [void](Wait-AmNmPlayback -TimeoutMs $PlayWaitMs)
    } else { $internalInvoke.error = 'no-action-control-found-inside-the-row' }
  }

  $auditAfter = New-AmNmAudit
  $cmp = Compare-AmNmAudit $auditBefore $auditAfter
  $smtcAfter = Get-AmNmSmtc
  $playing = Test-AmNmTargetPlaying $smtcAfter $title $artist
  $probe.smtcChanged = (('' + $smtcAfter.title) -ne ('' + $smtcBefore.title)) -or (('' + $smtcAfter.status) -ne ('' + $smtcBefore.status))
  $probe.smtcExpected = $playing.ok

  $result = 'PROBE_ONLY'
  if ($target -eq $null) { $result = 'NO_TARGET_ELEMENT' }
  elseif ($playing.ok -and (-not $cmp.mouseMoved) -and (-not $cmp.foregroundChanged)) { $result = 'NO_MOUSE_ACTIVATION_PASS' }
  elseif ($playing.ok -and $cmp.foregroundChangedByApplication) { $result = 'ACTIVATION_FOREGROUND_STEAL' }
  elseif ($playing.ok) { $result = 'UNATTRIBUTED_SUCCESS' }
  elseif ($internalInvoke.invoked -and -not $playing.ok) { $result = 'INTERNAL_INVOKE_NO_EFFECT' }
  elseif ($probe.actionSucceeded -and -not $playing.ok) { $result = 'ACTION_NO_EFFECT' }
  elseif ($probe.detail -like 'pattern-id-not-resolvable*') { $result = 'PATTERN_NOT_RESOLVABLE' }
  elseif (-not $probe.patternExists) { $result = 'PATTERN_NOT_SUPPORTED' }
  elseif ($probe.treeChanged) { $result = 'TREE_CHANGED_NO_PLAYBACK' }
  else { $result = 'NO_EFFECT_NO_TREE_CHANGE' }

  $line = '{' +
    '"case":"' + (Esc $j.caseId) + '","scenario":"' + (Esc $j.scenario) + '","attempt":' + $attempt +
    ',"pattern":"' + (Esc $j.pattern) + '","patternId":' + $j.pid +
    ',"target":{"found":' + (B ($target -ne $null)) + ',"title":"' + (Esc $title) + '","url":"' + (Esc $url) +
      '","titleRowsMatched":' + $rowAnalysis.rows.Count + ',"mainRowGuess":"' + (Esc $rowAnalysis.mainRowGuess) + '"' +
      ',"rowEvidence":' + (($rowAnalysis.rows | ConvertTo-Json -Depth 4 -Compress) -replace '"', "'") + '},' +
    '"realized":' + (B ($realize -ne $null -and $realize.realizeOk)) + ',' +
    '"geometry":{"before":"' + (Esc ($(if ($realize) { $realize.boundsBefore } else { '' }))) + '","afterRealize":"' + (Esc ($(if ($realize) { $realize.boundsAfterRealize } else { '' }))) + '","afterScroll":"' + (Esc ($(if ($realize) { $realize.boundsAfterScroll } else { '' }))) + '","geometryAfter":' + (B ($realize -ne $null -and $realize.geometryAfter)) + '},' +
    '"probe":{"patternExists":' + (B $probe.patternExists) + ',"supportsAction":' + (B $probe.supportsAction) + ',"actionInvoked":' + (B $probe.actionInvoked) + ',"actionSucceeded":' + (B $probe.actionSucceeded) + ',"actionError":"' + (Esc $probe.actionError) + '","treeChanged":' + (B $probe.treeChanged) + ',"newControlsMaterialized":' + $probe.newControlsMaterialized + ',"geometryChanged":' + $probe.geometryChanged + ',"smtcChanged":' + (B $probe.smtcChanged) + ',"smtcExpected":' + (B $probe.smtcExpected) + ',"detail":"' + (Esc $probe.detail) + '"},' +
    '"internalCandidates":{"count":' + $internalCandidates.Count + ',"list":' + (($internalCandidates | ConvertTo-Json -Depth 3 -Compress) -replace '"', "'") + '},' +
    '"internalInvoke":{"attempted":' + (B $internalInvoke.attempted) + ',"candidate":"' + (Esc $internalInvoke.candidate) + '","candidatePatterns":"' + (Esc $internalInvoke.candidatePatterns) + '","invoked":' + (B $internalInvoke.invoked) + ',"error":"' + (Esc $internalInvoke.error) + '"},' +
    '"pauseRan":' + (B $pauseRan) + ',' +
    '"smtcBefore":{"title":"' + (Esc $smtcBefore.title) + '","status":"' + (Esc $smtcBefore.status) + '"},' +
    '"smtcAfter":{"title":"' + (Esc $smtcAfter.title) + '","artist":"' + (Esc $smtcAfter.artist) + '","status":"' + (Esc $smtcAfter.status) + '","playing":' + (B $playing.playing) + '},' +
    '"cursorBefore":"' + (Esc $cmp.cursorBefore) + '","cursorAfter":"' + (Esc $cmp.cursorAfter) + '",' +
    '"foregroundBefore":"' + (Esc $cmp.foregroundBefore) + '","foregroundAfter":"' + (Esc $cmp.foregroundAfter) + '",' +
    '"mouseMoved":' + (B $cmp.mouseMoved) + ',"foregroundChanged":' + (B $cmp.foregroundChanged) + ',"foregroundChangedByApplication":' + (B $cmp.foregroundChangedByApplication) + ',"keyboardInjected":false,' +
    '"result":"' + (Esc $result) + '","timestamp":"' + (Esc (Get-AmNmIso)) + '"' +
  '}'
  [System.IO.File]::AppendAllText($jsonlPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ('   result=' + $result + ' probe(exists=' + $probe.patternExists + ',invoked=' + $probe.actionInvoked + ',ok=' + $probe.actionSucceeded + ') treeChanged=' + $probe.treeChanged + ' newControls=' + $probe.newControlsMaterialized + ' geomAfter=' + ($realize -ne $null -and $realize.geometryAfter) + ' innerCandidates=' + $internalCandidates.Count + ' innerInvoke=' + $internalInvoke.invoked + ' pause=' + $pauseRan + ' smtc=[' + $smtcAfter.title + '/' + $smtcAfter.status + '] mouse=' + $cmp.mouseMoved + ' fg=' + $cmp.foregroundChanged)
  Start-Sleep -Milliseconds 400
}
Stop-AmNmScenario
Write-Host ''
Write-Host ('records: ' + $attempt + ' -> ' + $jsonlPath)
