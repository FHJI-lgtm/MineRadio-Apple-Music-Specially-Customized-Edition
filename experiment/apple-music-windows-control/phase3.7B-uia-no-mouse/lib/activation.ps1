# ============================================================
# phase3.7B-uia-no-mouse/lib/activation.ps1
# NO-MOUSE, NO-FOREGROUND-STEAL, NO-KEYBOARD activation experiments.
#
# Every action is attributed: one action is performed, then SMTC is polled, so the
# report can say which action (if any) caused playback.  Combinations are recorded
# step by step, never as "the last state only".
# ASCII-only.
# ============================================================

. (Join-Path $PSScriptRoot 'patterns.ps1')

$script:AmNmSetupLog = New-Object System.Collections.Generic.List[string]

# ---- scenario preparation (allowed: it changes the USER's starting state on
# purpose; it is logged and is never part of the activation itself) -------------
function Set-AmNmScenario {
  param([string]$Scenario, [string]$AmHwnd = 0, [int]$Minimize = 0)
  $script:AmNmSetupLog.Clear()
  # bring a *control* application to the foreground so foreground stealing is observable
  if ($Scenario -in @('N1', 'N2', 'N4')) {
    try {
      $np = Start-Process -FilePath 'notepad.exe' -PassThru -ErrorAction Stop
      Start-Sleep -Milliseconds 1200
      $script:AmNmSetupLog.Add('started notepad for the foreground scenario pid=' + $np.Id)
    } catch { $script:AmNmSetupLog.Add('notepad start failed: ' + $_.Exception.Message) }
  }
  if ($Scenario -eq 'N2' -and $AmHwnd -ne 0) {
    [void][AmNm.Native]::ShowWindow([IntPtr]$AmHwnd, 6)   # SW_MINIMIZE (setup only)
    Start-Sleep -Milliseconds 700
    $script:AmNmSetupLog.Add('minimized Apple Music for N2 (setup only)')
  }
  if ($Scenario -eq 'N3' -and $AmHwnd -ne 0) {
    [void][AmNm.Native]::ShowWindow([IntPtr]$AmHwnd, 9)   # SW_RESTORE (setup only)
    Start-Sleep -Milliseconds 700
    $script:AmNmSetupLog.Add('restored Apple Music for N3 (setup only)')
  }
  Start-Sleep -Milliseconds 400
  return @($script:AmNmSetupLog)
}

function Stop-AmNmScenario {
  Get-Process -Name notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# ---- realization sequence (NO mouse / NO foreground / NO keys) ---------------
function Invoke-AmNmRealize {
  param($Element, [string]$Label = 'target')
  $r = [ordered]@{ label = $Label; steps = @(); boundsBefore = ''; boundsAfterRealize = ''; boundsAfterScroll = ''
                   realizeOk = $null; scrollOk = $null; geometryBefore = $false; geometryAfter = $false
                   offscreenBefore = $null; offscreenAfter = $null; error = ''; element = $Element }
  if ($Element -eq $null) { $r.error = 'null-element'; return $r }
  $i0 = Get-AmNmElementInfo $Element
  $r.boundsBefore = $i0.bounds; $r.offscreenBefore = $i0.isOffscreen
  $r.geometryBefore = (($i0.boundsWidth -gt 0) -and ($i0.boundsHeight -gt 0))
  $r.steps += ('before bounds=' + $i0.bounds + ' offscreen=' + $i0.isOffscreen)

  $obj = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.VirtualizedItemPattern]::Pattern, [ref]$obj)) {
    try { $obj.Realize(); $r.realizeOk = $true } catch { $r.realizeOk = $false; $r.error = $_.Exception.Message }
  } else { $r.realizeOk = $false }
  Start-Sleep -Milliseconds 500
  $i1 = Get-AmNmElementInfo $Element
  $r.boundsAfterRealize = $i1.bounds
  $r.steps += ('after Realize bounds=' + $i1.bounds + ' realizeOk=' + $r.realizeOk)

  $obj2 = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$obj2)) {
    try { $obj2.ScrollIntoView(); $r.scrollOk = $true } catch { $r.scrollOk = $false; if (-not $r.error) { $r.error = $_.Exception.Message } }
  } else { $r.scrollOk = $false }
  Start-Sleep -Milliseconds 500
  $i2 = Get-AmNmElementInfo $Element
  $r.boundsAfterScroll = $i2.bounds; $r.offscreenAfter = $i2.isOffscreen
  $r.geometryAfter = (($i2.boundsWidth -gt 0) -and ($i2.boundsHeight -gt 0))
  $r.steps += ('after ScrollIntoView bounds=' + $i2.bounds + ' scrollOk=' + $r.scrollOk + ' geometryAfter=' + $r.geometryAfter)
  return $r
}

# ---- a single, attributed action --------------------------------------------
function Invoke-AmNmAction {
  param($Element, [string]$Strategy)
  $r = [ordered]@{ strategy = $Strategy; supported = $false; attempted = $false; succeeded = $false; error = '' }
  if ($Element -eq $null) { $r.error = 'null-element'; return $r }
  $obj = $null
  switch ($Strategy) {
    'invoke' {
      if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$obj)) {
        $r.supported = $true; $r.attempted = $true
        try { $obj.Invoke(); $r.succeeded = $true } catch { $r.error = $_.Exception.Message }
      }
    }
    'select' {
      if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$obj)) {
        $r.supported = $true; $r.attempted = $true
        try { $obj.Select(); $r.succeeded = $true } catch { $r.error = $_.Exception.Message }
      }
    }
    'legacy-default' {
      $pat = Get-AmNmPatternRef 10018
      if ($pat -ne $null -and $Element.TryGetCurrentPattern($pat, [ref]$obj)) {
        $r.supported = $true; $r.attempted = $true
        try { $obj.DoDefaultAction(); $r.succeeded = $true } catch { $r.error = $_.Exception.Message }
      } elseif ($pat -eq $null) { $r.error = 'legacy-pattern-id-not-resolvable' }
    }
    'legacy-select' {
      $pat = Get-AmNmPatternRef 10018
      if ($pat -ne $null -and $Element.TryGetCurrentPattern($pat, [ref]$obj)) {
        $r.supported = $true; $r.attempted = $true
        try { $obj.Select(3); $r.succeeded = $true } catch { $r.error = $_.Exception.Message }
      } elseif ($pat -eq $null) { $r.error = 'legacy-pattern-id-not-resolvable' }
    }
    default { $r.error = 'unknown-strategy' }
  }
  return $r
}

function Wait-AmNmPlayback {
  param([int]$TimeoutMs = 6000, [int]$PollMs = 400)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $last = $null
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    Start-Sleep -Milliseconds $PollMs
    $last = Get-AmNmSmtc
    if (('' + $last.status) -eq 'Playing') { break }
  }
  if ($last -eq $null) { $last = Get-AmNmSmtc }
  return @{ smtc = $last; elapsedMs = [int]$sw.ElapsedMilliseconds }
}
