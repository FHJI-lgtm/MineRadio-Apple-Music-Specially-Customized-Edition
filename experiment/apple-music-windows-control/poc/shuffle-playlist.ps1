# Shuffle-play a LIBRARY playlist: navigate to the playlist page, then invoke the PAGE shuffle button
# (AutomationId=ShuffleButton WITH InvokePattern; the transport-bar one shares the id but is Toggle).
# Non-frozen POC wrapper. No coordinates: semantic InvokePattern only. One invoke per run.
param([string]$NameFile, [string]$ScopeFile, [string]$ShuffleLabelFile, [string]$OutFile, [switch]$NoMinimize)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function RT([string]$p) { return ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)).Trim() }
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
. (Join-Path $lib 'am-uia.ps1')
. (Join-Path $lib 'am-play.ps1')
. (Join-Path $lib 'am-play-playlist.ps1')
$pl = RT $NameFile; $scope = RT $ScopeFile; $shuffleLabel = RT $ShuffleLabelFile
$o = [ordered]@{ ok = $false; verified = $false; stage = ''; name = $pl; steps = [ordered]@{} }
$app = Ensure-AmRunning
[void](Invoke-AmForeground $app.hwnd)
$s0 = Get-AmSmtcState
$o.steps.before = @{ status = [string]$s0.status; title = [string]$s0.title }
function Get-TransportShuffleState($root) {
  try {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'ShuffleButton')
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    for ($i = 0; $i -lt $all.Count; $i++) {
      $e = $all.Item($i)
      try {
        $ob = $null
        if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$ob)) { return [string]$ob.Current.ToggleState }
      } catch { }
    }
  } catch { }
  return ''
}
function Find-PageShuffleButton($root, $label) {
  $out = @()
  try {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'ShuffleButton')
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    for ($i = 0; $i -lt $all.Count; $i++) {
      $e = $all.Item($i)
      try {
        $ip = $null
        if (-not $e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { continue }
        if ($label) { if (([string]$e.Current.Name).Trim() -ne $label) { continue } }
        $r = $e.Current.BoundingRectangle
        if (-not (Test-AmRectSane $r)) { continue }
        $out += [pscustomobject]@{ element = $e; pattern = $ip; name = [string]$e.Current.Name; rect = $r }
      } catch { }
    }
  } catch { }
  return $out
}
$o.steps.shuffleBefore = (Get-TransportShuffleState (Get-AmRoot $app.hwnd).root)
[void](Invoke-AmSearch (Get-AmRoot $app.hwnd).root $pl $app.hwnd 6000)
Start-Sleep -Milliseconds 900
$chip = Find-AmScopeChip (Get-AmRoot $app.hwnd).root $scope
if ($chip) { [void](Invoke-AmScopeChipSelect $chip) }
Start-Sleep -Milliseconds 900
$cards = @((Get-AmPlaylistCardCandidates (Get-AmRoot $app.hwnd).root $pl).candidates)
$exact = @($cards | Where-Object { (Normalize-AmText ([string]$_.name)) -eq (Normalize-AmText $pl) })
$pick = $null ; if ($exact.Count -eq 1) { $pick = $exact[0] } elseif ($cards.Count -eq 1) { $pick = $cards[0] }
$o.steps.search = @{ candidates = $cards.Count; exactMatches = $exact.Count; picked = [bool]$pick }
if (-not $pick) { $o.stage = 'AMBIGUOUS_CARD' } else {
  try { $cr = $pick.element.Current.BoundingRectangle } catch { $cr = $null }
  $cp = Get-AmSafeClickPoint $cr
  $o.steps.navigate = @{ ok = [bool](Invoke-AmRowPlay $app.hwnd $pick.element $cp.x $cp.y).ok }
  Start-Sleep -Seconds 3
  $root = (Get-AmRoot $app.hwnd).root
  $btns = @(Find-PageShuffleButton $root $shuffleLabel)
  $o.steps.pageShuffleCandidates = @($btns | ForEach-Object { @{ name = $_.name; rect = ('' + [int]$_.rect.Left + ',' + [int]$_.rect.Top + ' ' + [int]$_.rect.Width + 'x' + [int]$_.rect.Height) } })
  if ($btns.Count -ne 1) { $o.stage = ('SHUFFLE_BUTTON_COUNT_' + $btns.Count) } else {
    $b = $btns[0]
    $o.steps.invoke = @{ name = $b.name; rect = ('' + [int]$b.rect.Left + ',' + [int]$b.rect.Top + ' ' + [int]$b.rect.Width + 'x' + [int]$b.rect.Height); calls = 1 }
    try { $b.pattern.Invoke(); $o.ok = $true } catch { $o.stage = 'INVOKE_THREW'; $o.error = [string]$_.Exception.Message }
    Start-Sleep -Seconds 4
    # Read the toggle state BEFORE minimizing: a minimized window exposes almost no UIA tree.
    $o.steps.shuffleAfter = (Get-TransportShuffleState (Get-AmRoot $app.hwnd).root)
    # Same post-click hide the verified playlist/song chains perform (frozen Hide-AmAfterClick).
    $o.steps.minimizedAfterClick = (Hide-AmAfterClick $app.hwnd -NoMinimize:$NoMinimize)
    $s1 = Get-AmSmtcState
    $o.steps.smtcAfter = @{ status = [string]$s1.status; title = [string]$s1.title; artist = [string]$s1.artist }
    $o.shuffleModeConfirmed = ([string]$o.steps.shuffleBefore -eq 'Off' -and [string]$o.steps.shuffleAfter -eq 'On')
    if ($o.ok) { if (($o.steps.smtcAfter.status -eq 'Playing') -or $o.shuffleModeConfirmed) { $o.verified = $true; $o.stage = 'PLAYBACK_STARTED' } else { $o.stage = 'NO_PLAYBACK' } }
  }
}
$json = ($o | ConvertTo-Json -Compress -Depth 8)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json