# ============================================================
# phase3.7A-navigation/lib/nav-experiment.ps1
# The E10 navigation experiment matrix.  Every case is observed with exactly the
# same instrumentation; only the two experimental axes change:
#   axis 1 - the URL / storefront (D1..D6)
#   axis 2 - the invocation method and the app state before the URL arrives
# Controls A/B/C (known-good in Phase 3.6) run through the identical code path.
# No clicks, no SMTC control, no input synthesis, nothing frozen is touched.
# ASCII-only.
# ============================================================

. (Join-Path $PSScriptRoot 'nav-common.ps1')

$script:NavFullPoints = @(0, 250, 500, 1000, 2000, 4000, 6000, 8000, 12000)
$script:NavShortPoints = @(0, 1000, 4000, 12000)

# window activation used ONLY by the experiment (the frozen libs are never loaded)
if (-not ('AmNav.Win' -as [type])) {
  Add-Type -Namespace AmNav -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@
}

function Ensure-AmNavRunning {
  $info = Get-AmNavWindowInfo
  if (-not $info.uiaWindowFound) {
    Write-Host '  [prep] Apple Music not running, launching...'
    Start-Process -FilePath $script:AmNavExe | Out-Null
    for ($i = 1; $i -le 30; $i++) {
      Start-Sleep -Seconds 1
      $info = Get-AmNavWindowInfo
      if ($info.uiaWindowFound) { break }
    }
  }
  $info = Get-AmNavWindowInfo
  if ($info.uiaWindowFound -and $info.iconic) {
    # a minimized window is a genuine app state: record it, then make the window
    # visible again so a navigation failure cannot be blamed on minimization
    Write-Host '  [prep] window is minimized (iconic=True): SW_RESTORE + foreground'
    $h = [IntPtr]$info.hwnd
    [void][AmNav.Win]::ShowWindow($h, 9)
    Start-Sleep -Milliseconds 700
    [void][AmNav.Win]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 500
    $info = Get-AmNavWindowInfo
    Write-Host ('  [prep] after activation: iconic=' + $info.iconic + ' visible=' + $info.visible + ' foreground=' + $info.isForeground)
  }
  return $info
}

# prepare the app state that the E10 URL will land on
function Set-AmNavPreState {
  param([string]$Kind = 'other-song', [string]$PrepareUrl = '')
  if ($Kind -eq 'other-song' -and $PrepareUrl -ne '') {
    Write-Host ('  [prep] navigating to the control song first: ' + $PrepareUrl)
    [void](Invoke-AmNavDeepLink -Url $PrepareUrl -Method 'url')
    Start-Sleep -Milliseconds 4000
  } elseif ($Kind -eq 'nearby' -and $PrepareUrl -ne '') {
    Write-Host ('  [prep] navigating to a nearby page first: ' + $PrepareUrl)
    [void](Invoke-AmNavDeepLink -Url $PrepareUrl -Method 'url')
    Start-Sleep -Milliseconds 4000
  }
}

function Get-AmNavVerdict {
  param($Case, $Result)
  $targets = @($Case.targets)
  $final = $Result.final
  $pre = $Result.pre
  $hitTitle = $false; $hitArtist = $false
  foreach ($t in $targets) { if ($final.textHits -ne $null -and $final.textHits.ContainsKey($t) -and $final.textHits[$t]) { if ($t -eq $Case.title) { $hitTitle = $true } else { $hitArtist = $true } } }
  $smtcMatches = ($final.smtcTitle -ne '' -and ($final.smtcTitle.ToLowerInvariant().Contains((('' + $Case.title).ToLowerInvariant()))))
  $pageChanged = ($final.signature -ne $pre.uia.signature)
  $listItemDelta = ([int]$final.listItemCount - [int]$pre.uia.listItemCount)
  $navigated = ($hitTitle -or $smtcMatches)

  $verdict = 'UNKNOWN'
  if ($navigated -and ($hitTitle -or $hitArtist)) { $verdict = 'NAVIGATION_OK_VISIBLE' }
  elseif ($smtcMatches -and -not $hitTitle) { $verdict = 'NAVIGATION_ALREADY_SUCCEEDED_UIA_STALE' }
  elseif ($pageChanged) { $verdict = 'NAVIGATION_TARGET_PAGE_DIFFERENT' }
  elseif (-not $pageChanged) {
    if (-not $Result.invocation.started) { $verdict = 'NAVIGATION_URL_REJECTED' }
    else { $verdict = 'NAVIGATION_TIMEOUT' }
  }
  return [ordered]@{
    verdict = $verdict; targetTitleVisible = $hitTitle; targetArtistVisible = $hitArtist; smtcMatchesTarget = $smtcMatches
    pageChanged = $pageChanged; signatureBefore = $pre.uia.signature; signatureAfter = $final.signature
    listItemsBefore = $pre.uia.listItemCount; listItemsAfter = $final.listItemCount; listItemDelta = $listItemDelta
    windowTitleBefore = $pre.window.title; windowTitleAfter = $final.windowTitle
    smtcBefore = ($pre.smtc.title + ' / ' + $pre.smtc.status); smtcAfter = ($final.smtcTitle + ' / ' + $final.smtcStatus)
    invocationStarted = $Result.invocation.started; invocationError = $Result.invocation.error; invocationExitCode = $Result.invocation.exitCode
  }
}

function Invoke-AmNavCase {
  param($Case, [switch]$Full, [switch]$NoPrepare)
  Write-Host ('== case ' + $Case.id + ' :: ' + $Case.kind + ' :: ' + $Case.url)
  if (-not $NoPrepare) { Set-AmNavPreState -Kind $Case.preState -PrepareUrl $Case.prepareUrl }
  $targets = @($Case.targets)
  $points = $script:NavShortPoints
  if ($Full) { $points = $script:NavFullPoints }
  $r = Measure-AmNavTimeline -Url $Case.url -Method $Case.method -Targets $targets -Points $points
  $v = Get-AmNavVerdict -Case $Case -Result $r
  $dir = Get-AmNavReportDir
  $row = [ordered]@{
    id = $Case.id; kind = $Case.kind; url = $Case.url; method = $Case.method; preState = $Case.preState
    title = $Case.title; artist = $Case.artist; songId = $Case.songId; storefront = $Case.storefront
    expectation = $Case.expectation
    verdict = $v.verdict; targetTitleVisible = $v.targetTitleVisible; targetArtistVisible = $v.targetArtistVisible
    smtcMatchesTarget = $v.smtcMatchesTarget; pageChanged = $v.pageChanged
    signatureBefore = $v.signatureBefore; signatureAfter = $v.signatureAfter
    listItemsBefore = $v.listItemsBefore; listItemsAfter = $v.listItemsAfter
    windowTitleBefore = $v.windowTitleBefore; windowTitleAfter = $v.windowTitleAfter
    smtcBefore = $v.smtcBefore; smtcAfter = $v.smtcAfter
    invocationStarted = $v.invocationStarted; invocationError = $v.invocationError; invocationExitCode = $v.invocationExitCode
    invocationCommand = $r.invocation.command; invocationElapsedMs = $r.invocation.elapsedMs
    firstChangeMs = Get-AmNavFirstChangeMs -Result $r
    timeline = $r.timeline
  }
  Write-AmNavJson (Join-Path $dir ('timeline-' + $Case.id + '.json')) $row
  Write-Host ('   verdict=' + $v.verdict + ' pageChanged=' + $v.pageChanged + ' listItems ' + $v.listItemsBefore + '->' + $v.listItemsAfter + ' title=[' + $v.windowTitleBefore + ']->[' + $v.windowTitleAfter + '] smtc=[' + $v.smtcAfter + ']')
  return $row
}

function Get-AmNavFirstChangeMs {
  param($Result)
  $pre = $Result.pre.uia.signature
  foreach ($s in $Result.timeline) { if ($s.signature -ne $pre) { return $s.pointMs } }
  return -1
}

function Invoke-AmNavMatrix {
  param($Data, [string[]]$Only = @(), [switch]$NoPrepare, [switch]$Full)
  $rows = New-Object System.Collections.Generic.List[object]
  [void](Ensure-AmNavRunning)
  Write-Host ('Apple Music window: ' + (Get-AmNavWindowInfo).title)

  # ---- controls first, so the environment is proven before touching E10 ----
  foreach ($c in $Data.controls) {
    if ($Only.Count -gt 0 -and ($Only -notcontains $c.id)) { continue }
    $case = [ordered]@{ id = ('CTRL-' + $c.id); kind = 'control'; url = $c.url; method = 'url'; preState = 'other-song'
      prepareUrl = ''; title = $c.title; artist = $c.artist; songId = $c.songId; storefront = $c.storefront
      targets = @($c.title, $c.artist); expectation = 'navigation should succeed' }
    $rows.Add((Invoke-AmNavCase -Case $case -Full:$Full -NoPrepare:$NoPrepare))
  }

  # ---- E10 url / storefront axis ----
  foreach ($u in $Data.target.urlVariants) {
    if ($Only.Count -gt 0 -and ($Only -notcontains $u.id)) { continue }
    $case = [ordered]@{ id = $u.id; kind = ('e10/' + $u.kind); url = $u.url; method = 'url'; preState = 'other-song'
      prepareUrl = $Data.controls[2].url; title = $Data.target.title; artist = $Data.target.artist
      songId = $Data.target.songId; storefront = $u.storefront; targets = @($Data.target.title, $Data.target.artist)
      expectation = $u.expectation }
    $rows.Add((Invoke-AmNavCase -Case $case -Full:$Full -NoPrepare:$NoPrepare))
  }

  # ---- invocation axis ----
  foreach ($i in $Data.target.invocationVariants) {
    if ($Only.Count -gt 0 -and ($Only -notcontains $i.id)) { continue }
    $case = [ordered]@{ id = $i.id; kind = ('e10/invocation/' + $i.method); url = $i.url; method = $i.method; preState = 'other-song'
      prepareUrl = $Data.controls[2].url; title = $Data.target.title; artist = $Data.target.artist
      songId = $Data.target.songId; storefront = 'cn'; targets = @($Data.target.title, $Data.target.artist)
      expectation = $i.expectation }
    $rows.Add((Invoke-AmNavCase -Case $case -Full:$Full -NoPrepare:$NoPrepare))
  }

  # ---- app-state axis ----
  foreach ($s in $Data.target.stateVariants) {
    if ($Only.Count -gt 0 -and ($Only -notcontains $s.id)) { continue }
    $case = [ordered]@{ id = $s.id; kind = ('e10/state/' + $s.preState); url = $Data.target.canonicalUrl; method = 'url'
      preState = $s.preState; prepareUrl = $s.prepareUrl; title = $Data.target.title; artist = $Data.target.artist
      songId = $Data.target.songId; storefront = 'cn'; targets = @($Data.target.title, $Data.target.artist)
      expectation = $s.expectation }
    $rows.Add((Invoke-AmNavCase -Case $case -Full:$Full -NoPrepare:$NoPrepare))
  }

  $dir = Get-AmNavReportDir
  $out = [ordered]@{ startedAt = (Get-Date).ToString('s'); controls = $Data.controls.Count; cases = $rows.Count; rows = $rows }
  Write-AmNavJson (Join-Path $dir 'matrix.json') $out
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('| test | kind | url | method | preState | verdict | pageChanged | listItems | window title before -> after | smtc after | firstChangeMs |')
  $lines.Add('|---|---|---|---|---|---|---|---|---|---|---|')
  foreach ($r in $rows) {
    $lines.Add('| ' + $r.id + ' | ' + $r.kind + ' | ' + $r.url + ' | ' + $r.method + ' | ' + $r.preState + ' | **' + $r.verdict + '** | ' + $r.pageChanged + ' | ' + $r.listItemsBefore + ' -> ' + $r.listItemsAfter + ' | ' + $r.windowTitleBefore + ' -> ' + $r.windowTitleAfter + ' | ' + $r.smtcAfter + ' | ' + $r.firstChangeMs + ' |')
  }
  Write-AmNavText (Join-Path $dir 'matrix.md') ($lines -join "`r`n")
  Write-Host ''
  Write-Host ('matrix rows: ' + $rows.Count + ' -> ' + (Join-Path $dir 'matrix.md'))
  return $out
}
