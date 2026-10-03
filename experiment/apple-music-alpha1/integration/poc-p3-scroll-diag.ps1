# Stage 1+2: enumerate scroll containers on the playlist page, then ONE SetScrollPercent(NoAmount,25) probe.
param([string]$PlaylistFile, [string]$ScopeFile, [string]$TitleFile, [string]$ArtistFile, [string]$OutFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function RT([string]$p) { return ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)).Trim() }
function R2($r) { if (-not $r) { return '' } ; return ('' + [int]$r.Left + ',' + [int]$r.Top + ' ' + [int]$r.Width + 'x' + [int]$r.Height) }
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
. (Join-Path $lib 'am-uia.ps1')
. (Join-Path $lib 'am-play.ps1')
. (Join-Path $lib 'am-play-playlist.ps1')
$pl = RT $PlaylistFile; $scope = RT $ScopeFile; $title = RT $TitleFile; $artist = RT $ArtistFile
$want = Normalize-AmText $title; $wantA = Normalize-AmText $artist
function Get-All($root) { try { return @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) } catch { return @() } }
function Count-Target($all) { $n = 0; foreach ($x in $all) { try { $nm = [string]$x.Current.Name; if ($nm -and (Normalize-AmText $nm).IndexOf($want) -ge 0 -and (Normalize-AmText $nm).IndexOf($wantA) -ge 0) { $n++ } } catch { } } ; return $n }
$o = [ordered]@{ playlist = $pl; target = $title; containers = @(); chosen = $null; probe = @{}; verdict = '' }
$app = Ensure-AmRunning
[void](Invoke-AmSearch (Get-AmRoot $app.hwnd).root $pl $app.hwnd 6000)
Start-Sleep -Milliseconds 800
$chip = Find-AmScopeChip (Get-AmRoot $app.hwnd).root $scope
if ($chip) { [void](Invoke-AmScopeChipSelect $chip) }
Start-Sleep -Milliseconds 800
$cards = @((Get-AmPlaylistCardCandidates (Get-AmRoot $app.hwnd).root $pl).candidates)
$exact = @($cards | Where-Object { (Normalize-AmText ([string]$_.name)) -eq (Normalize-AmText $pl) })
$pick = $null ; if ($exact.Count -eq 1) { $pick = $exact[0] } elseif ($cards.Count -eq 1) { $pick = $cards[0] }
$o.search = @{ candidates = $cards.Count; exactMatches = $exact.Count; picked = [bool]$pick }
if (-not $pick) { $o.verdict = 'INCONCLUSIVE_AMBIGUOUS_CARD' } else {
  try { $cr = $pick.element.Current.BoundingRectangle } catch { $cr = $null }
  $cp = Get-AmSafeClickPoint $cr
  $o.navigation = @{ ok = [bool](Invoke-AmRowPlay $app.hwnd $pick.element $cp.x $cp.y).ok }
  Start-Sleep -Seconds 3
  $all = Get-All (Get-AmRoot $app.hwnd).root
  $m = 0; foreach ($n in $all) { try { if ((Normalize-AmText ([string]$n.Current.Name)) -eq (Normalize-AmText $pl)) { $m++ } } catch { } }
  $o.playlistIdentity = @{ matches = $m }
  $o.matchesAtStart = (Count-Target $all)
  $best = $null
  foreach ($n in $all) {
    try {
      $ob = $null
      if (-not $n.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$ob)) { continue }
      $ct = ''; $aid = ''; $nm = ''; $rc = ''
      try { $ct = [string]$n.Current.ControlType.ProgrammaticName } catch { }
      try { $aid = [string]$n.Current.AutomationId } catch { }
      try { $nm = [string]$n.Current.Name } catch { }
      try { $rc = R2 $n.Current.BoundingRectangle } catch { }
      $vs = $false; $pct = -1; $viewSz = -1
      try { $vs = [bool]$ob.Current.VerticallyScrollable } catch { }
      try { $pct = [math]::Round([double]$ob.Current.VerticalScrollPercent, 1) } catch { }
      try { $viewSz = [math]::Round([double]$ob.Current.VerticalViewSize, 1) } catch { }
      $li = 0
      try { foreach ($d in $n.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { try { if (([string]$d.Current.ControlType.ProgrammaticName) -eq 'ControlType.ListItem') { $li++ } } catch { } } } catch { }
      $rec = @{ type = $ct; automationId = $aid; name = (Truncate-AmText $nm 40); rect = $rc; scrollPattern = $true; verticallyScrollable = $vs; percent = $pct; viewSize = $viewSz; listItemsInside = $li }
      $o.containers += $rec
      if ($vs -and $pct -ge 0 -and $li -gt 0 -and -not $best) { $best = @{ el = $n; ob = $ob; rec = $rec } }
    } catch { }
  }
  $o.containerCount = @($o.containers).Count
  if (-not $best) { $o.verdict = 'INCONCLUSIVE_NO_SUITABLE_SCROLLER' } else {
    $o.chosen = $best.rec
    $before = @{ percent = $best.rec.percent; viewSize = $best.rec.viewSize; rows = (Get-All (Get-AmRoot $app.hwnd).root).Count; targetMatches = (Count-Target (Get-All (Get-AmRoot $app.hwnd).root)) }
    $err = ''
    try { $best.ob.SetScrollPercent([System.Windows.Automation.ScrollAmount]::NoAmount, 25) } catch { $err = [string]$_.Exception.GetType().FullName + ' :: ' + [string]$_.Exception.Message }
    Start-Sleep -Seconds 2
    $all2 = Get-All (Get-AmRoot $app.hwnd).root
    $after = @{ percent = -1; viewSize = -1 }
    try { $after.percent = [math]::Round([double]$best.ob.Current.VerticalScrollPercent, 1) } catch { }
    try { $after.viewSize = [math]::Round([double]$best.ob.Current.VerticalViewSize, 1) } catch { }
    $after.rows = @($all2).Count
    $after.targetMatches = (Count-Target $all2)
    $o.probe = @{ call = 'SetScrollPercent(NoAmount, 25)'; error = $err; before = $before; after = $after; percentChanged = ($after.percent -ne $before.percent); rowSetChanged = ($after.rows -ne $before.rows); targetMatchesChanged = ($after.targetMatches -ne $before.targetMatches) }
    if ($err -eq '' -and ($after.percent -ne $before.percent)) { $o.verdict = 'DIAG_SCROLL_WORKS' }
    elseif ($err -eq '' -and ($after.rows -ne $before.rows)) { $o.verdict = 'DIAG_UI_CHANGED_PERCENT_UNCHANGED' }
    elseif ($err -eq '') { $o.verdict = 'INCONCLUSIVE_NO_VERIFIABLE_CHANGE' }
    else { $o.verdict = 'INCONCLUSIVE_SETSCROLLPERCENT_THREW' }
  }
}
$json = ($o | ConvertTo-Json -Compress -Depth 8)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json