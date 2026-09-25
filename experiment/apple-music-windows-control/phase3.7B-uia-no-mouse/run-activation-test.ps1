# ============================================================
# phase3.7B-uia-no-mouse/run-activation-test.ps1
# Stage 2-4: attributed, audited no-mouse activation attempts.
#
#   .\run-activation-test.ps1              bounded default matrix
#   .\run-activation-test.ps1 -Full        all scenarios x all strategies
#   .\run-activation-test.ps1 -Only E10-N1-invoke
#
# Hard rules enforced here: no mouse API, no SetForegroundWindow, no keyboard input.
# Scenario preparation (starting a control app, minimizing Apple Music) is logged and
# happens BEFORE the audited window; the activation itself is audited on both sides.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param([switch]$Full, [string[]]$Only = @(), [int]$PlayWaitMs = 6000)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\activation.ps1')

$cfg = Get-Content -Path (Join-Path $PSScriptRoot 'cases\E10.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$controls = @((Get-Content -Path (Join-Path $PSScriptRoot 'cases\controls.json') -Raw -Encoding UTF8 | ConvertFrom-Json).controls)
$dir = Get-AmNmReportDir
$stamp = Get-AmStamp

$hygiene = Test-AmNmScriptHygiene
Write-Host ('MouseGuard (static): ok=' + $hygiene.ok + ' hits=[' + ($hygiene.hits -join '; ') + ']')
if (-not $hygiene.ok) { Write-Host 'FORBIDDEN MOUSE API FOUND IN EXPERIMENT SOURCES - FAIL'; exit 3 }

function Invoke-AmNmPause {
  # SMTC control only (no mouse, no keyboard): gives every run a known baseline
  try {
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $flags = [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static -bor [System.Reflection.BindingFlags]::InvokeMethod
    $mgr = Await-AmNavWinRt ($mgrType.InvokeMember('RequestAsync', $flags, $null, $null, @())) $mgrType 4000
    if ($mgr -eq $null) { return $false }
    foreach ($s in @($mgr.GetSessions())) {
      if (('' + $s.SourceAppUserModelId) -like '*AppleMusic*') { [void](Await-AmNavWinRt ($s.TryPauseAsync()) ([Windows.Foundation.IAsyncOperation`1[System.Boolean]]) 3000); return $true }
    }
  } catch { }
  return $false
}

$jobs = @()
foreach ($s in $cfg.scenarios) {
  foreach ($st in @('invoke', 'select', 'realize+invoke')) {
    $jobs += , [ordered]@{ caseId = 'E10'; title = $cfg.target.title; artist = $cfg.target.artist; url = $cfg.target.url; scenario = $s.id; scenarioDesc = $s.desc; minimize = $s.minimize; other = $s.otherAppForeground; restore = $s.restore; preload = $s.preloadTarget; strategy = $st }
  }
}
foreach ($c in $controls) {
  $jobs += , [ordered]@{ caseId = ('CTRL-' + $c.id); title = $c.title; artist = $c.artist; url = $c.url; scenario = 'N1'; scenarioDesc = 'Apple Music visible, NOT foreground'; minimize = 0; other = $true; restore = 0; preload = $false; strategy = 'invoke' }
}
if ($Full) {
  foreach ($s in $cfg.scenarios) {
    foreach ($st in @('legacy-default', 'legacy-select', 'realize+select', 'realize+invoke+select')) {
      $jobs += , [ordered]@{ caseId = 'E10'; title = $cfg.target.title; artist = $cfg.target.artist; url = $cfg.target.url; scenario = $s.id; scenarioDesc = $s.desc; minimize = $s.minimize; other = $s.otherAppForeground; restore = $s.restore; preload = $s.preloadTarget; strategy = $st }
    }
  }
}
if ($Only.Count -gt 0) { $jobs = @($jobs | Where-Object { $Only -contains ($_.caseId + '-' + $_.scenario + '-' + $_.strategy) }) }

$rows = New-Object System.Collections.Generic.List[object]
foreach ($j in $jobs) {
  $id = ($j.caseId + '-' + $j.scenario + '-' + $j.strategy)
  Write-Host ('== ' + $id + ' :: ' + $j.title + ' :: ' + $j.strategy)
  $w = Get-AmNavWindowInfo
  if (-not $w.uiaWindowFound) { Write-Host '  Apple Music window not found - skipping'; continue }
  $setup = Set-AmNmScenario -Scenario $j.scenario -AmHwnd $w.hwnd
  if ($j.other) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'echo scenario foreground holder' -WindowStyle Minimized -ErrorAction SilentlyContinue | Out-Null; Start-Sleep -Milliseconds 800 }
  if (-not $j.preload) { [void](Invoke-AmNavDeepLink -Url $j.url -Method 'url'); Start-Sleep -Seconds 3 }
  [void](Invoke-AmNmPause)
  Start-Sleep -Milliseconds 400

  $rootEl = Get-AmNavWindowElement
  $found = Find-AmNmTargetElements $rootEl $j.title $j.artist
  $target = $null
  if ($found.listItemMatches.Count -gt 0) { $target = $found.listItemMatches[0].element }

  $auditBefore = New-AmNmAudit
  $realize = $null; $action = $null; $smtcAfter = $null; $playWait = 0
  $verdict = ''
  if ($target -eq $null) {
    $verdict = 'NO_TARGET_ELEMENT'
  } else {
    $realize = Invoke-AmNmRealize -Element $target -Label $id
    $strategy = $j.strategy
    if ($strategy -like 'realize+*') {
      $parts = @($strategy.Split('+') | Where-Object { $_ -ne 'realize' })
      $action = Invoke-AmNmAction -Element $target -Strategy $parts[0]
      $wait = Wait-AmNmPlayback -TimeoutMs $PlayWaitMs
      $smtcAfter = $wait.smtc; $playWait = $wait.elapsedMs
      if (('' + $smtcAfter.status) -ne 'Playing' -and $parts.Count -gt 1) {
        $a2 = Invoke-AmNmAction -Element $target -Strategy $parts[1]
        $action = @{ first = $action; second = $a2 }
        $wait2 = Wait-AmNmPlayback -TimeoutMs $PlayWaitMs
        $smtcAfter = $wait2.smtc; $playWait += $wait2.elapsedMs
      }
    } else {
      $action = Invoke-AmNmAction -Element $target -Strategy $strategy
      $wait = Wait-AmNmPlayback -TimeoutMs $PlayWaitMs
      $smtcAfter = $wait.smtc; $playWait = $wait.elapsedMs
    }
  }
  $auditAfter = New-AmNmAudit
  $cmp = Compare-AmNmAudit $auditBefore $auditAfter
  if ($smtcAfter -eq $null) { $smtcAfter = Get-AmNmSmtc }
  $playing = Test-AmNmTargetPlaying $smtcAfter $j.title $j.artist

  if ($verdict -eq '') {
    $realizedOk = ($realize -ne $null -and $realize.geometryAfter)
    $supported = $false; $succeeded = $false
    if ($action -is [hashtable] -and $action.ContainsKey('first')) { $supported = ($action.first.supported -or $action.second.supported); $succeeded = ($action.first.succeeded -or $action.second.succeeded) }
    elseif ($action -ne $null) { $supported = $action.supported; $succeeded = $action.succeeded }
    if (-not $supported) { $verdict = 'PATTERN_NOT_SUPPORTED' }
    elseif ($playing.ok -and (-not $cmp.mouseMoved) -and (-not $cmp.foregroundChanged)) { $verdict = 'NO_MOUSE_ACTIVATION_PASS' }
    elseif ($playing.ok -and $cmp.foregroundChangedByApplication) { $verdict = 'ACTIVATION_FOREGROUND_STEAL' }
    elseif ($playing.ok) { $verdict = 'UNATTRIBUTED_SUCCESS' }
    elseif ($playing.smtcTitle -ne '' -and (-not $playing.titleOk)) { $verdict = 'WRONG_TRACK' }
    elseif (-not $realizedOk -and (-not $found.listItemMatches[0].boundsWidth)) { $verdict = 'UIA_REALIZATION_UNAVAILABLE' }
    else { $verdict = 'ACTION_NO_EFFECT' }
  }

  $row = [ordered]@{
    id = $id; caseId = $j.caseId; scenario = $j.scenario; scenarioDesc = $j.scenarioDesc; strategy = $j.strategy
    title = $j.title; artist = $j.artist; url = $j.url; setup = @($setup)
    targetFound = ($target -ne $null); listItemTotal = $found.listItemTotal; nodes = $found.nodes
    targetBounds = $(if ($found.listItemMatches.Count -gt 0) { $found.listItemMatches[0].bounds } else { '' })
    targetOffscreen = $(if ($found.listItemMatches.Count -gt 0) { $found.listItemMatches[0].isOffscreen } else { $null })
    targetPatterns = $(if ($found.listItemMatches.Count -gt 0) { @($found.listItemMatches[0].patterns.available) } else { @() })
    realize = $(if ($realize -ne $null) { @{ realizeOk = $realize.realizeOk; scrollOk = $realize.scrollOk; boundsBefore = $realize.boundsBefore; boundsAfterRealize = $realize.boundsAfterRealize; boundsAfterScroll = $realize.boundsAfterScroll; geometryBefore = $realize.geometryBefore; geometryAfter = $realize.geometryAfter; steps = @($realize.steps) } } else { $null })
    action = $action
    verdict = $verdict
    smtcAfter = @{ title = $playing.smtcTitle; artist = $playing.smtcArtist; status = $playing.smtcStatus; titleOk = $playing.titleOk; artistOk = $playing.artistOk; playing = $playing.playing }
    playWaitMs = $playWait
    audit = $cmp
    auditedBefore = $auditBefore
    auditedAfter = $auditAfter
    ts = (Get-AmIsoNow)
  }
  $rows.Add($row)
  Write-Host ('   verdict=' + $verdict + ' realized=' + $(if ($realize) { $realize.geometryAfter } else { 'n/a' }) + ' smtc=[' + $playing.smtcTitle + '/' + $playing.smtcStatus + '] mouseMoved=' + $cmp.mouseMoved + ' fgChanged=' + $cmp.foregroundChanged + ' fgByApp=' + $cmp.foregroundChangedByApplication + ' wait=' + $playWait + 'ms')
  Start-Sleep -Milliseconds 500
}
Stop-AmNmScenario

$out = [ordered]@{ stamp = $stamp; jobs = $rows.Count; mouseGuardStatic = $hygiene; playWaitMs = $PlayWaitMs; rows = $rows }
Write-AmNavJson (Join-Path $dir ('activation-' + $stamp + '.json')) $out
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('| test | scenario | strategy | target found | realize geometry | verdict | smtc after | mouse moved | fg changed | fg stolen by app | wait ms |')
$lines.Add('|---|---|---|---|---|---|---|---|---|---|---|')
foreach ($r in $rows) {
  $geom = 'n/a'; if ($r.realize -ne $null) { $geom = $r.realize.geometryAfter }
  $lines.Add('| ' + $r.id + ' | ' + $r.scenario + ' | ' + $r.strategy + ' | ' + $r.targetFound + ' | ' + $geom + ' | **' + $r.verdict + '** | ' + $r.smtcAfter.title + ' / ' + $r.smtcAfter.status + ' | ' + $r.audit.mouseMoved + ' | ' + $r.audit.foregroundChanged + ' | ' + $r.audit.foregroundChangedByApplication + ' | ' + $r.playWaitMs + ' |')
}
Write-AmNavText (Join-Path $dir ('activation-' + $stamp + '.md')) ($lines -join "`r`n")
Write-Host ''
Write-Host ('runs: ' + $rows.Count + ' -> ' + (Join-Path $dir ('activation-' + $stamp + '.md')))
$grouped = $rows | Group-Object verdict | ForEach-Object { $_.Name + '=' + $_.Count }
Write-Host ('verdicts: ' + ($grouped -join ', '))
