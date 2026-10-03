# P-3 phase 1 variant C: target row requires SCROLLING (bounded, semantic ScrollPattern - no mouse wheel).
param([string]$PlaylistFile, [string]$ScopeFile, [string]$TitleFile, [string]$ArtistFile, [string]$OutFile, [int]$MaxScroll = 12)
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
$want = Normalize-AmText $title; $wantArtist = Normalize-AmText $artist
function Get-AllNodes($root) { try { return @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) } catch { return @() } }
function Scan-Rows($all) {
  $rows = @(); $errs = 0
  foreach ($n in $all) {
    $nm = ''
    try { $nm = [string]$n.Current.Name } catch { $errs++; continue }
    if (-not $nm) { continue }
    if ((Normalize-AmText $nm).IndexOf($want) -lt 0) { continue }
    $cur = $n; $row = $null
    for ($d = 0; $d -lt 8 -and $cur; $d++) {
      try { $ct = [string]$cur.Current.ControlType.ProgrammaticName } catch { $ct = '' }
      if ($ct -eq 'ControlType.ListItem') { $row = $cur; break }
      try { $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur) } catch { $cur = $null; $errs++ }
    }
    if (-not $row) { continue }
    $txt = ''
    try { $acc = @(); foreach ($d in $row.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { try { $acc += [string]$d.Current.Name } catch { $errs++ } } ; $txt = ($acc -join ' ') } catch { $errs++ }
    if ($wantArtist -and (Normalize-AmText $txt).IndexOf($wantArtist) -lt 0) { continue }
    if (-not ($rows | Where-Object { $_ -eq $row })) { $rows += $row }
  }
  return @{ rows = $rows; errs = $errs }
}
$o = [ordered]@{ playlist = $pl; target = $title; steps = [ordered]@{}; scroll = @(); verdict = '' }
$sw = [Diagnostics.Stopwatch]::StartNew()
$app = Ensure-AmRunning
$s0 = Get-AmSmtcState
$o.steps.before = @{ status = [string]$s0.status; title = [string]$s0.title }
[void](Invoke-AmSearch (Get-AmRoot $app.hwnd).root $pl $app.hwnd 6000)
Start-Sleep -Milliseconds 800
$chip = Find-AmScopeChip (Get-AmRoot $app.hwnd).root $scope
if ($chip) { [void](Invoke-AmScopeChipSelect $chip) }
Start-Sleep -Milliseconds 800
$cards = @((Get-AmPlaylistCardCandidates (Get-AmRoot $app.hwnd).root $pl).candidates)
$exact = @($cards | Where-Object { (Normalize-AmText ([string]$_.name)) -eq (Normalize-AmText $pl) })
$o.steps.search = @{ candidates = $cards.Count; exactMatches = $exact.Count; names = @($cards | ForEach-Object { Truncate-AmText ([string]$_.name) 40 }) }
$pick = $null
if ($exact.Count -eq 1) { $pick = $exact[0] } elseif ($cards.Count -eq 1) { $pick = $cards[0] }
if (-not $pick) { $o.verdict = 'INCONCLUSIVE_AMBIGUOUS_CARD' } else {
  try { $cr = $pick.element.Current.BoundingRectangle } catch { $cr = $null }
  $cp = Get-AmSafeClickPoint $cr
  $cc = Invoke-AmRowPlay $app.hwnd $pick.element $cp.x $cp.y
  $o.steps.navigation = @{ ok = [bool]$cc.ok }
  Start-Sleep -Seconds 3
  $s1 = Get-AmSmtcState
  $o.steps.afterNavigation = @{ status = [string]$s1.status; title = [string]$s1.title }
  $root = (Get-AmRoot $app.hwnd).root
  $all = Get-AllNodes $root
  $m = 0; foreach ($n in $all) { try { if ((Normalize-AmText ([string]$n.Current.Name)) -eq (Normalize-AmText $pl)) { $m++ } } catch { } }
  $o.steps.playlistIdentity = @{ matches = $m }
  $scroller = $null; $sp = $null
  foreach ($n in $all) { try { $ob = $null; if ($n.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$ob)) { if ($ob.Current.VerticallyScrollable) { $scroller = $n; $sp = $ob; break } } } catch { } }
  $o.steps.scrollerFound = [bool]$sp
  $found = $null; $stagnant = 0; $lastPct = -1
  for ($step = 0; $step -le $MaxScroll; $step++) {
    $allStep = Get-AllNodes (Get-AmRoot $app.hwnd).root
    $scan = Scan-Rows $allStep
    $pct = -1; if ($sp) { try { $pct = [math]::Round([double]$sp.Current.VerticalScrollPercent, 1) } catch { $pct = -1 } }
    $o.scroll += @{ step = $step; percent = $pct; matches = @($scan.rows).Count; errors = $scan.errs }
    if (@($scan.rows).Count -eq 1) { $found = $scan.rows[0]; break }
    if (-not $sp) { break }
    if ($pct -eq $lastPct) { $stagnant++ } else { $stagnant = 0 }
    if ($stagnant -ge 2) { $o.steps.stagnantStop = $true; break }
    $lastPct = $pct
    try { $sp.Scroll([System.Windows.Automation.ScrollAmount]::LargeIncrement, [System.Windows.Automation.ScrollAmount]::NoAmount) } catch { $o.steps.scrollError = [string]$_.Exception.Message; break }
    Start-Sleep -Milliseconds 900
  }
  $o.steps.rowFound = [bool]$found
  if (-not $found) { $o.verdict = 'INCONCLUSIVE_ROW_NOT_FOUND_AFTER_SCROLL' } else {
    try { [void](Realize-AmRow $found 2500 120 $app.hwnd) } catch { }
    $rr = $null; try { $rr = $found.Current.BoundingRectangle } catch { $rr = $null }
    $tEl = $null; $tRect = $null
    try { foreach ($d in $found.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { $dn = ''; $dt = ''; try { $dn = [string]$d.Current.Name } catch { } ; try { $dt = [string]$d.Current.ControlType.ProgrammaticName } catch { } ; if (-not $dn) { continue } ; if ($dt -eq 'ControlType.Text' -and (Normalize-AmText $dn).IndexOf($want) -ge 0 -and -not $tEl) { $tEl = $d; try { $tRect = $d.Current.BoundingRectangle } catch { } } } } catch { }
    $o.steps.geometry = @{ rowRect = (R2 $rr); titleRect = (R2 $tRect) }
    $final = $null
    if ($tRect -and $rr -and $rr.Width -gt 80) { $cx = $tRect.Left + ($tRect.Width / 2); $cy = $tRect.Top + ($tRect.Height / 2); if ($cx -ge ($rr.Left + 40) -and $cx -le ($rr.Left + $rr.Width - 40)) { $final = @{ name = 'titleCenter'; x = $cx; y = $cy } } }
    if (-not $final -and $rr -and $rr.Width -gt 80) { $final = @{ name = 'rowRatio45'; x = ($rr.Left + ($rr.Width * 0.45)); y = ($rr.Top + ($rr.Height / 2)) } }
    if (-not $final) { $o.verdict = 'INCONCLUSIVE_NO_VALID_AIM' } else {
      $o.steps.finalAim = @{ name = $final.name; x = [int]$final.x; y = [int]$final.y }
      $row2 = $null; try { $row2 = $found.Current.BoundingRectangle } catch { $row2 = $null }
      $o.steps.rowStillValid = [bool]($row2 -and $row2.Width -gt 0)
      if (-not $o.steps.rowStillValid) { $o.verdict = 'INCONCLUSIVE_ROW_INVALIDATED' } else {
        $pt = Get-AmSafeClickPoint (New-Object System.Windows.Rect($final.x, $final.y, 2, 2))
        $c1 = Invoke-AmRowPlay $app.hwnd $null $pt.x $pt.y
        $o.steps.click = @{ calls = 1; ok = [bool]$c1.ok; x = [int]$pt.x; y = [int]$pt.y; evidence = 'INFERRED_HELPER_DOUBLE_CLICKS' }
        Start-Sleep -Seconds 4
        $s2 = Get-AmSmtcState
        $o.steps.smtcAfter = @{ status = [string]$s2.status; title = [string]$s2.title; artist = [string]$s2.artist; ts = (Get-Date).ToString('s') }
        if ((Normalize-AmText ([string]$s2.title)).IndexOf($want) -ge 0) { $o.verdict = 'PASS_PHASE1_SCROLL' } else { $o.verdict = 'INCONCLUSIVE_SMTC_MISMATCH' }
      }
    }
  }
}
$o.elapsedMs = [int]$sw.ElapsedMilliseconds
$json = ($o | ConvertTo-Json -Compress -Depth 8)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json