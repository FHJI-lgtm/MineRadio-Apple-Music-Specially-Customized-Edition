# ============================================================
# phase3.7B.1-uia-contract (runner kept in the 3.7B folder for continuity)
# phase3.7B-uia-no-mouse/run-activation-test.ps1
#
# Instrumentation repaired: every run is written as an explicit pscustomobject with
# a fixed field set, and this runner carries its own clock helpers so it no longer
# depends on am-common.  Per-run record (mandatory fields):
#   case scenario attempt target realized geometry invoke select smtcBefore smtcAfter
#   cursorBefore cursorAfter foregroundBefore foregroundAfter mouseMoved
#   foregroundChanged keyboardInjected result timestamp
#
# Additional 3.7B.1 probes: ItemContainerPattern(10019), ExpandCollapsePattern(10005),
# TogglePattern(10015), materialization census/diff around Realize and the action,
# anchor chain + child scan, and the "which of the matching rows is the main row" analysis.
#
# Hard rules: no mouse API, no SetForegroundWindow, no keyboard input.  Scenario setup
# is logged and happens outside the audited window.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param([switch]$Full, [string[]]$Only = @(), [int]$PlayWaitMs = 4000, [switch]$RowsOnly)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\activation.ps1')
. (Join-Path $PSScriptRoot 'lib\contract.ps1')

function Get-AmNmStamp { return (Get-Date).ToString('yyyyMMdd-HHmmss') }
function Get-AmNmIso { return (Get-Date).ToString('s') }

$cfg = Get-Content -Path (Join-Path $PSScriptRoot 'cases\E10.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$controls = @((Get-Content -Path (Join-Path $PSScriptRoot 'cases\controls.json') -Raw -Encoding UTF8 | ConvertFrom-Json).controls)
$dir = Get-AmNmReportDir
$stamp = Get-AmNmStamp

$hygiene = Test-AmNmScriptHygiene
Write-Host ('MouseGuard (static): ok=' + $hygiene.ok + ' scanned=' + $hygiene.scanned + ' hits=[' + ($hygiene.hits -join '; ') + ']')
if (-not $hygiene.ok) { Write-Host 'FORBIDDEN MOUSE API FOUND - FAIL'; exit 3 }

$jobs = @()
if ($RowsOnly) {
  $jobs += , @{ caseId = 'E10'; title = $cfg.target.title; artist = $cfg.target.artist; url = $cfg.target.url; scenario = 'N1'; minimize = 0; other = $true; restore = 0; preload = $false; strategy = 'row-analysis' }
} else {
  foreach ($st in @('item-container', 'expand-collapse', 'toggle', 'probe-chain')) {
    $jobs += , @{ caseId = 'E10'; title = $cfg.target.title; artist = $cfg.target.artist; url = $cfg.target.url; scenario = 'N1'; minimize = 0; other = $true; restore = 0; preload = $false; strategy = $st }
  }
  foreach ($sc in @('N2', 'N4')) {
    $jobs += , @{ caseId = 'E10'; title = $cfg.target.title; artist = $cfg.target.artist; url = $cfg.target.url; scenario = $sc; minimize = $(if ($sc -eq 'N2') { 1 } else { 0 }); other = $true; restore = 0; preload = ($sc -eq 'N4'); strategy = 'probe-chain' }
  }
  foreach ($c in $controls) {
    $jobs += , @{ caseId = ('CTRL-' + $c.id); title = $c.title; artist = $c.artist; url = $c.url; scenario = 'N1'; minimize = 0; other = $true; restore = 0; preload = $false; strategy = 'probe-chain' }
  }
  if ($Full) {
    foreach ($sc in @('N1', 'N2', 'N3', 'N4')) {
      foreach ($st in @('invoke', 'select', 'item-container', 'expand-collapse', 'toggle', 'probe-chain')) {
        $jobs += , @{ caseId = 'E10'; title = $cfg.target.title; artist = $cfg.target.artist; url = $cfg.target.url; scenario = $sc; minimize = $(if ($sc -eq 'N2') { 1 } else { 0 }); other = ($sc -ne 'N3'); restore = $(if ($sc -eq 'N3') { 1 } else { 0 }); preload = ($sc -eq 'N4'); strategy = $st }
      }
    }
  }
}
if ($Only.Count -gt 0) { $jobs = @($jobs | Where-Object { $Only -contains ($_.caseId + '-' + $_.scenario + '-' + $_.strategy) }) }

$rows = New-Object System.Collections.Generic.List[object]
$attempt = 0
foreach ($j in $jobs) {
  $attempt++
  $id = ($j.caseId + '-' + $j.scenario + '-' + $j.strategy)
  Write-Host ('== [' + $attempt + '/' + $jobs.Count + '] ' + $id)
  $w = Get-AmNavWindowInfo
  if (-not $w.uiaWindowFound) { Write-Host '  window missing - skip'; continue }
  $setup = @(Set-AmNmScenario -Scenario $j.scenario -AmHwnd $w.hwnd)
  if ($j.other) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'echo foreground holder' -WindowStyle Minimized -ErrorAction SilentlyContinue | Out-Null; Start-Sleep -Milliseconds 700 }
  if (-not $j.preload) { [void](Invoke-AmNavDeepLink -Url $j.url -Method 'url'); Start-Sleep -Seconds 3 }
  [void](Invoke-AmNmPause)
  Start-Sleep -Milliseconds 400

  $auditBefore = New-AmNmAudit
  $rootEl = Get-AmNavWindowElement
  $rowAnalysis = Get-AmNmRowAnalysis $rootEl $j.title $j.artist
  $censusBefore = Get-AmNmCensus $rootEl
  $target = $null
  if ($rowAnalysis.rows.Count -gt 0) {
    # prefer the row with geometry, else the first match (documented in rowAnalysis)
    $withGeom = @($rowAnalysis.rows | Where-Object { $_.boundsWidth -gt 0 })
    if ($withGeom.Count -gt 0) { $targetOrdinal = $withGeom[0].ordinal } else { $targetOrdinal = 1 }
    $found = Find-AmNmTargetElements $rootEl $j.title $j.artist
    if ($found.listItemMatches.Count -ge $targetOrdinal) { $target = $found.listItemMatches[$targetOrdinal - 1].element }
  }

  $realize = $null; $censusAfterRealize = $null; $censusDiffRealize = $null
  $invokeRes = @{ attempted = $false; supported = $false; succeeded = $false; error = '' }
  $selectRes = @{ attempted = $false; supported = $false; succeeded = $false; error = '' }
  $extra = [ordered]@{}
  $smtcBefore = Get-AmNmSmtc
  if ($target -ne $null) {
    $realize = Invoke-AmNmRealize -Element $target -Label $id
    $censusAfterRealize = Get-AmNmCensus $rootEl
    $censusDiffRealize = Get-AmNmCensusDiff $censusBefore $censusAfterRealize
    $childScan = Get-AmNmChildScan $target 2
    $anchorChain = Get-AmNmAnchorChain $target 5
    $listEl = $null
    foreach ($a in $anchorChain) { if ($a.controlType -eq 'ControlType.List') { $listEl = $a; break } }
    $extra['childScanAfterRealize'] = $childScan
    $extra['anchorTypes'] = @($anchorChain | ForEach-Object { $_.controlType })
    $extra['anchorClasses'] = @($anchorChain | ForEach-Object { $_.className })
    if ($listEl -ne $null) {
      $extra['anchorListAutomationId'] = $listEl.automationId
      $extra['anchorListBounds'] = $listEl.bounds
    }
    $st = $j.strategy
    if ($st -in @('invoke', 'probe-chain')) {
      $a1 = Invoke-AmNmAction -Element $target -Strategy 'invoke'
      $invokeRes = @{ attempted = $a1.attempted; supported = $a1.supported; succeeded = $a1.succeeded; error = $a1.error }
      $wait1 = Wait-AmNmPlayback -TimeoutMs $PlayWaitMs
      $extra['afterInvokeSmtc'] = ('' + $wait1.smtc.title + '/' + $wait1.smtc.status)
      $extra['afterInvokeWaitMs'] = $wait1.elapsedMs
    }
    if ($st -in @('select', 'probe-chain')) {
      $a2 = Invoke-AmNmAction -Element $target -Strategy 'select'
      $selectRes = @{ attempted = $a2.attempted; supported = $a2.supported; succeeded = $a2.succeeded; error = $a2.error }
      $wait2 = Wait-AmNmPlayback -TimeoutMs $PlayWaitMs
      $extra['afterSelectSmtc'] = ('' + $wait2.smtc.title + '/' + $wait2.smtc.status)
      $extra['afterSelectWaitMs'] = $wait2.elapsedMs
    }
    if ($st -eq 'item-container') {
      $ic = $null
      if ($listEl -ne $null) { $ic = Invoke-AmNmItemContainerProbe $listEl $j.title }
      $extra['itemContainer'] = $ic
    }
    if ($st -in @('expand-collapse', 'toggle')) {
      $pid2 = $(if ($st -eq 'expand-collapse') { 10005 } else { 10015 })
      $sup = Test-AmNmPatternSupport $target $pid2
      $extra['patternProbe'] = @{ id = $pid2; strategy = $st; resolvable = $sup.resolvable; supported = $sup.supported; error = $sup.error }
      if ($sup.supported) {
        $obj = $null
        $pat = Get-AmNmPatternRef $pid2
        [void]$target.TryGetCurrentPattern($pat, [ref]$obj)
        try {
          if ($st -eq 'expand-collapse') { $obj.Expand() } else { $obj.Toggle() }
          $extra['patternProbe']['invoked'] = $true
        } catch { $extra['patternProbe']['invoked'] = $false; $extra['patternProbe']['invokeError'] = $_.Exception.Message }
      }
      $wait3 = Wait-AmNmPlayback -TimeoutMs $PlayWaitMs
      $extra['afterPatternSmtc'] = ('' + $wait3.smtc.title + '/' + $wait3.smtc.status)
    }
    $censusAfterAction = Get-AmNmCensus $rootEl
    $extra['censusDiffAfterAction'] = Get-AmNmCensusDiff $censusAfterRealize $censusAfterAction
  }

  $auditAfter = New-AmNmAudit
  $cmp = Compare-AmNmAudit $auditBefore $auditAfter
  $smtcAfter = Get-AmNmSmtc
  $playing = Test-AmNmTargetPlaying $smtcAfter $j.title $j.artist

  $result = 'NO_TARGET_ELEMENT'
  if ($target -eq $null) { $result = 'NO_TARGET_ELEMENT' }
  elseif ($j.strategy -eq 'row-analysis') { $result = 'ROW_ANALYSIS_ONLY' }
  elseif ($playing.ok -and (-not $cmp.mouseMoved) -and (-not $cmp.foregroundChanged)) { $result = 'NO_MOUSE_ACTIVATION_PASS' }
  elseif ($playing.ok -and $cmp.foregroundChangedByApplication) { $result = 'ACTIVATION_FOREGROUND_STEAL' }
  elseif ($playing.ok) { $result = 'UNATTRIBUTED_SUCCESS' }
  elseif ($extra.Contains('itemContainer') -and $extra['itemContainer'] -ne $null -and $extra['itemContainer'].supported -and $extra['itemContainer'].findByName -eq 'match') { $result = 'ITEM_CONTAINER_REACHABLE_NO_PLAYBACK' }
  elseif (($invokeRes.succeeded -or $selectRes.succeeded) -and (-not $playing.playing)) { $result = 'ACTION_NO_EFFECT' }
  elseif (-not $invokeRes.supported -and -not $selectRes.supported) { $result = 'PATTERN_NOT_SUPPORTED' }
  else { $result = 'PROBE_ONLY_NO_PLAYBACK' }

  $row = [pscustomobject][ordered]@{
    case = $j.caseId
    scenario = $j.scenario
    attempt = $attempt
    strategy = $j.strategy
    target = [ordered]@{ found = ($target -ne $null); title = $j.title; artist = $j.artist; url = $j.url
                         rowAnalysis = $rowAnalysis; patternsAvailable = $(if ($rowAnalysis.rows.Count -gt 0) { @($rowAnalysis.rows[0].patterns) } else { @() }) }
    realized = $(if ($realize -ne $null) { $realize.realizeOk } else { $null })
    geometry = [ordered]@{ before = $(if ($realize -ne $null) { $realize.boundsBefore } else { '' })
                           afterRealize = $(if ($realize -ne $null) { $realize.boundsAfterRealize } else { '' })
                           afterScroll = $(if ($realize -ne $null) { $realize.boundsAfterScroll } else { '' })
                           geometryBefore = $(if ($realize -ne $null) { $realize.geometryBefore } else { $false })
                           geometryAfter = $(if ($realize -ne $null) { $realize.geometryAfter } else { $false }) }
    invoke = $invokeRes
    select = $selectRes
    extra = $extra
    census = [ordered]@{ before = $censusBefore; afterRealize = $censusAfterRealize; diffRealize = $censusDiffRealize }
    smtcBefore = [ordered]@{ title = ('' + $smtcBefore.title); artist = ('' + $smtcBefore.artist); status = ('' + $smtcBefore.status) }
    smtcAfter = [ordered]@{ title = ('' + $smtcAfter.title); artist = ('' + $smtcAfter.artist); status = ('' + $smtcAfter.status); titleOk = $playing.titleOk; artistOk = $playing.artistOk; playing = $playing.playing }
    cursorBefore = $cmp.cursorBefore
    cursorAfter = $cmp.cursorAfter
    foregroundBefore = $cmp.foregroundBefore
    foregroundAfter = $cmp.foregroundAfter
    mouseMoved = $cmp.mouseMoved
    foregroundChanged = $cmp.foregroundChanged
    foregroundChangedByApplication = $cmp.foregroundChangedByApplication
    focusBefore = $cmp.focusBefore
    focusAfter = $cmp.focusAfter
    keyboardInjected = $false
    setupLog = $setup
    result = $result
    timestamp = Get-AmNmIso
  }
  $rows.Add($row)
  Write-Host ('   result=' + $result + ' geom=' + $row.geometry.geometryAfter + ' rows=' + $rowAnalysis.rows.Count + ' main=' + $rowAnalysis.mainRowGuess + ' invoke=' + $invokeRes.succeeded + ' select=' + $selectRes.succeeded + ' smtc=[' + $row.smtcAfter.title + '/' + $row.smtcAfter.status + '] mouse=' + $cmp.mouseMoved + ' fg=' + $cmp.foregroundChanged)
  Start-Sleep -Milliseconds 400
}
Stop-AmNmScenario

# ConvertTo-Json throws "Argument types do not match" on this PS 5.1 build for deeply
# nested OrderedDictionaries, and that exception aborted the whole run before any file
# was written.  So the per-run records are written as hand-built JSONL with exactly the
# mandated field set - guaranteed to land on disk, one line per run.
function Esc([string]$s) {
  if ($null -eq $s) { return '' }
  return ($s -replace '\\', '/' -replace '"', "'" -replace "`r", ' ' -replace "`n", ' ')
}
$stampPath = Join-Path $dir ('activation-' + $stamp +'.jsonl')
$written = 0
foreach ($r in $rows) {
  $extraJson = ''
  try { $extraJson = (($r.extra | ConvertTo-Json -Depth 6 -Compress)) } catch { $extraJson = '"extra-serialize-error"' }
  if ($null -eq $extraJson) { $extraJson = '{}' }
  $line = '{' +
    '"case":"' + (Esc $r.case) + '",' +
    '"scenario":"' + (Esc $r.scenario) + '",' +
    '"attempt":' + $r.attempt + ',' +
    '"strategy":"' + (Esc $r.strategy) + '",' +
    '"target":{"found":' + ($r.target.found.ToString().ToLower()) + ',"title":"' + (Esc $r.target.title) + '","url":"' + (Esc $r.target.url) + '",' +
      '"titleRowsMatched":' + $r.target.rowAnalysis.rows.Count + ',"totalListItems":' + $r.target.rowAnalysis.rows.Count + ',"mainRowGuess":"' + (Esc $r.target.rowAnalysis.mainRowGuess) + '",' +
      '"patternsAvailable":"' + (Esc ($r.target.patternsAvailable -join ',')) + '"},' +
    '"realized":' + ('' + $r.realized).ToLower() + ',' +
    '"geometry":{"before":"' + (Esc $r.geometry.before) + '","afterRealize":"' + (Esc $r.geometry.afterRealize) + '","afterScroll":"' + (Esc $r.geometry.afterScroll) + '","geometryAfter":' + ('' + $r.geometry.geometryAfter).ToLower() + '},' +
    '"invoke":{"attempted":' + ('' + $r.invoke.attempted).ToLower() + ',"supported":' + ('' + $r.invoke.supported).ToLower() + ',"succeeded":' + ('' + $r.invoke.succeeded).ToLower() + ',"error":"' + (Esc $r.invoke.error) + '"},' +
    '"select":{"attempted":' + ('' + $r.select.attempted).ToLower() + ',"supported":' + ('' + $r.select.supported).ToLower() + ',"succeeded":' + ('' + $r.select.succeeded).ToLower() + ',"error":"' + (Esc $r.select.error) + '"},' +
    '"smtcBefore":{"title":"' + (Esc $r.smtcBefore.title) + '","status":"' + (Esc $r.smtcBefore.status) + '"},' +
    '"smtcAfter":{"title":"' + (Esc $r.smtcAfter.title) + '","artist":"' + (Esc $r.smtcAfter.artist) + '","status":"' + (Esc $r.smtcAfter.status) + '","playing":' + ('' + $r.smtcAfter.playing).ToLower() + '},' +
    '"cursorBefore":"' + (Esc $r.cursorBefore) + '","cursorAfter":"' + (Esc $r.cursorAfter) + '",' +
    '"foregroundBefore":"' + (Esc $r.foregroundBefore) + '","foregroundAfter":"' + (Esc $r.foregroundAfter) + '",' +
    '"mouseMoved":' + ('' + $r.mouseMoved).ToLower() + ',' +
    '"foregroundChanged":' + ('' + $r.foregroundChanged).ToLower() + ',' +
    '"foregroundChangedByApplication":' + ('' + $r.foregroundChangedByApplication).ToLower() + ',' +
    '"keyboardInjected":false,' +
    '"result":"' + (Esc $r.result) + '",' +
    '"timestamp":"' + (Esc $r.timestamp) + '",' +
    '"extra":' + $extraJson +
  '}'
  [System.IO.File]::AppendAllText($stampPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
  $written++
}
Write-Host ('per-run jsonl records: ' + $written + ' -> ' + $stampPath)
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('| # | test | scenario | strategy | realized | geometry after | invoke | select | smtc after | mouse moved | fg changed | result |')
$lines.Add('|---|---|---|---|---|---|---|---|---|---|---|---|')
foreach ($r in $rows) {
  $lines.Add('| ' + $r.attempt + ' | ' + $r.case + '-' + $r.scenario + '-' + $r.strategy + ' | ' + $r.scenario + ' | ' + $r.strategy + ' | ' + $r.realized + ' | ' + $r.geometry.geometryAfter + ' | ' + $r.invoke.succeeded + ' | ' + $r.select.succeeded + ' | ' + $r.smtcAfter.title + ' / ' + $r.smtcAfter.status + ' | ' + $r.mouseMoved + ' | ' + $r.foregroundChanged + ' | **' + $r.result + '** |')
}
Set-Content -Path (Join-Path $dir ('activation-' + $stamp + '.md')) -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('runs=' + $rows.Count + ' -> ' + $jsonPath)
$g = @($rows | Group-Object result | ForEach-Object { $_.Name + '=' + $_.Count })
Write-Host ('results: ' + ($g -join ', '))
