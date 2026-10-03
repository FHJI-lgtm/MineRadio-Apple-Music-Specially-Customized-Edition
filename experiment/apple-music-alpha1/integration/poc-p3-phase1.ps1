# P-3 phase 1 (rerun): open the user PLAYLIST page (navigation only) then double-click ONE verified row.
# aim is constrained INSIDE the row with a 40px margin; badge detection excludes pure digits / mm:ss.
param([string]$PlaylistFile, [string]$ScopeFile, [string]$TitleFile, [string]$ArtistFile, [string]$OutFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function RT([string]$p) { return ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)).Trim() }
function R2($rect) { if (-not $rect) { return '' } ; return ('' + [int]$rect.Left + ',' + [int]$rect.Top + ' ' + [int]$rect.Width + 'x' + [int]$rect.Height) }
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
. (Join-Path $lib 'am-uia.ps1')
. (Join-Path $lib 'am-play.ps1')
. (Join-Path $lib 'am-play-playlist.ps1')
$pl = RT $PlaylistFile; $scope = RT $ScopeFile; $title = RT $TitleFile; $artist = RT $ArtistFile
$o = [ordered]@{ playlist = $pl; targetTitle = $title; steps = [ordered]@{}; verdict = '' }
$sw = [Diagnostics.Stopwatch]::StartNew()
$app = Ensure-AmRunning
$b0 = Get-AmSmtcState
$o.steps.precheck = @{ smtcStatus = [string]$b0.status; smtcTitle = [string]$b0.title; baselineIsTarget = ((Normalize-AmText ([string]$b0.title)).IndexOf((Normalize-AmText $title)) -ge 0) }
$o.steps.ensureApp = @{ ok = [bool]$app.ok; hwnd = [int]$app.hwnd }
try { $wr = New-Object AmUiaNative+RECT; [void][AmUiaNative]::GetWindowRect($app.hwnd, [ref]$wr); $o.steps.windowRect = ('' + $wr.Left + ',' + $wr.Top + ' ' + ($wr.Right - $wr.Left) + 'x' + ($wr.Bottom - $wr.Top)) } catch { $o.steps.windowRect = 'unavailable' }
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
  $o.steps.navigation = @{ cardOk = [bool]$cc.ok; x = [int]$cc.x; y = [int]$cc.y; recomputed = [bool]$cc.recomputed }
  Start-Sleep -Seconds 3
  $s1 = Get-AmSmtcState
  $o.steps.afterNavigation = @{ status = [string]$s1.status; title = [string]$s1.title; playbackChanged = ([string]$s1.title -ne [string]$b0.title) }
  $root = (Get-AmRoot $app.hwnd).root
  $all = @(); try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } catch { }
  $pageNames = @(); foreach ($n in $all) { try { $nm = [string]$n.Current.Name; if ($nm -and (Normalize-AmText $nm) -eq (Normalize-AmText $pl)) { $pageNames += $nm } } catch { } }
  $o.steps.playlistIdentity = @{ matches = $pageNames.Count }
  $want = Normalize-AmText $title; $wantArtist = Normalize-AmText $artist
  $rows = @()
  foreach ($n in $all) {
    $nm = ''; try { $nm = [string]$n.Current.Name } catch { continue }
    if (-not $nm) { continue }
    $cur = $n; $row = $null
    for ($d = 0; $d -lt 8 -and $cur; $d++) {
      try { $ct = [string]$cur.Current.ControlType.ProgrammaticName } catch { $ct = '' }
      if ($ct -eq 'ControlType.ListItem') { $row = $cur; break }
      try { $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur) } catch { $cur = $null }
    }
    if (-not $row) { continue }
    if ((Normalize-AmText $nm).IndexOf($want) -lt 0) { continue }
    $txt = ''
    try { $desc = $row.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition); $acc = @(); foreach ($d in $desc) { try { $acc += [string]$d.Current.Name } catch { } }; $txt = ($acc -join ' ') } catch { }
    if ($wantArtist -and (Normalize-AmText $txt).IndexOf($wantArtist) -lt 0) { continue }
    if (-not ($rows | Where-Object { $_ -eq $row })) { $rows += $row }
  }
  $o.steps.rowMatch = @{ count = $rows.Count; unique = ($rows.Count -eq 1) }
  if ($rows.Count -ne 1) { $o.verdict = 'INCONCLUSIVE_ROW_MATCH' } else {
    $row = $rows[0]
    try { [void](Realize-AmRow $row 2500 120 $app.hwnd) } catch { }
    $rr = $null; try { $rr = $row.Current.BoundingRectangle } catch { $rr = $null }
    $tEl = $null; $tRect = $null
    try { foreach ($d in $row.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { $dn = ''; $dt = ''; try { $dn = [string]$d.Current.Name } catch { } ; try { $dt = [string]$d.Current.ControlType.ProgrammaticName } catch { } ; if (-not $dn) { continue } ; if ($dt -eq 'ControlType.Text' -and (Normalize-AmText $dn).IndexOf($want) -ge 0 -and -not $tEl) { $tEl = $d; try { $tRect = $d.Current.BoundingRectangle } catch { } } } } catch { }
    $o.steps.geometry = @{ rowRect = (R2 $rr); titleRect = (R2 $tRect) }
    $cand = @()
    if ($tRect -and $rr) {
      $cx = $tRect.Left + ($tRect.Width / 2); $cy = $tRect.Top + ($tRect.Height / 2)
      $cand += @{ name = 'titleCenter'; x = $cx; y = $cy }
    }
    if ($rr) { $cand += @{ name = 'rowRatio45'; x = ($rr.Left + ($rr.Width * 0.45)); y = ($rr.Top + ($rr.Height / 2)) } }
    $o.steps.aimCandidates = @($cand | ForEach-Object { $_.name + '=' + [int]$_.x + ',' + [int]$_.y })
    $final = $null
    if ($rr -and $rr.Width -gt 80 -and $rr.Height -gt 0) {
      foreach ($c in $cand) {
        if ($c.x -ge ($rr.Left + 40) -and $c.x -le ($rr.Left + $rr.Width - 40) -and $c.y -ge $rr.Top -and $c.y -le ($rr.Top + $rr.Height)) { $final = $c; break }
      }
    }
    if (-not $final) { $o.verdict = 'INCONCLUSIVE_NO_VALID_AIM' } else {
      $o.steps.finalAim = @{ name = $final.name; x = [int]$final.x; y = [int]$final.y }
      $row2 = $null; try { $row2 = $row.Current.BoundingRectangle } catch { $row2 = $null }
      $o.steps.rowStillValid = [bool]($row2 -and $row2.Width -gt 0)
      if (-not $o.steps.rowStillValid) { $o.verdict = 'INCONCLUSIVE_ROW_INVALIDATED' } else {
        $pt = Get-AmSafeClickPoint (New-Object System.Windows.Rect($final.x, $final.y, 2, 2))
        $c1 = Invoke-AmRowPlay $app.hwnd $null $pt.x $pt.y
        $o.steps.click = @{ calls = 1; ok = [bool]$c1.ok; x = [int]$pt.x; y = [int]$pt.y; evidence = 'INFERRED_HELPER_DOUBLE_CLICKS' }
        Start-Sleep -Seconds 4
        $s2 = Get-AmSmtcState
        $o.steps.smtcAfter = @{ status = [string]$s2.status; title = [string]$s2.title; artist = [string]$s2.artist; ts = (Get-Date).ToString('s') }
        if ((Normalize-AmText ([string]$s2.title)).IndexOf($want) -ge 0) { $o.verdict = 'PASS_PHASE1' } else { $o.verdict = 'INCONCLUSIVE_SMTC_MISMATCH' }
      }
    }
  }
}
$o.elapsedMs = [int]$sw.ElapsedMilliseconds
$json = ($o | ConvertTo-Json -Compress -Depth 8)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json