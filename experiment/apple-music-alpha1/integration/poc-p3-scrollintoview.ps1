# Final semantic scroll experiment: ONE ScrollItemPattern.ScrollIntoView on a realized playlist row.
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
function Count-Target($all) { $n = 0; foreach ($x in $all) { try { $s = Normalize-AmText ([string]$x.Current.Name); if ($s.IndexOf($want) -ge 0 -and $s.IndexOf($wantA) -ge 0) { $n++ } } catch { } } ; return $n }
$o = [ordered]@{ playlist = $pl; target = $title; steps = [ordered]@{}; chosenRow = @{}; call = @{}; after = @{}; verdict = '' }
$app = Ensure-AmRunning
[void](Invoke-AmSearch (Get-AmRoot $app.hwnd).root $pl $app.hwnd 6000)
Start-Sleep -Milliseconds 800
$chip = Find-AmScopeChip (Get-AmRoot $app.hwnd).root $scope
if ($chip) { [void](Invoke-AmScopeChipSelect $chip) }
Start-Sleep -Milliseconds 800
$cards = @((Get-AmPlaylistCardCandidates (Get-AmRoot $app.hwnd).root $pl).candidates)
$exact = @($cards | Where-Object { (Normalize-AmText ([string]$_.name)) -eq (Normalize-AmText $pl) })
$pick = $null ; if ($exact.Count -eq 1) { $pick = $exact[0] } elseif ($cards.Count -eq 1) { $pick = $cards[0] }
if (-not $pick) { $o.verdict = 'INCONCLUSIVE_AMBIGUOUS_CARD' } else {
  try { $cr = $pick.element.Current.BoundingRectangle } catch { $cr = $null }
  $cp = Get-AmSafeClickPoint $cr
  $o.steps.navigation = @{ ok = [bool](Invoke-AmRowPlay $app.hwnd $pick.element $cp.x $cp.y).ok }
  Start-Sleep -Seconds 3
  $all0 = Get-All (Get-AmRoot $app.hwnd).root
  $m = 0; foreach ($n in $all0) { try { if ((Normalize-AmText ([string]$n.Current.Name)) -eq (Normalize-AmText $pl)) { $m++ } } catch { } }
  $o.steps.playlistIdentity = @{ matches = $m }
  $o.steps.matchesAtStart = (Count-Target $all0)
  $listEl = $null; $listSp = $null
  foreach ($n in $all0) { try { $ob = $null; if ($n.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$ob)) { if ($ob.Current.VerticallyScrollable) { $listEl = $n; $listSp = $ob; break } } } catch { } }
  $pct0 = -1; if ($listSp) { try { $pct0 = [math]::Round([double]$listSp.Current.VerticalScrollPercent, 1) } catch { } }
  $lr = $null; if ($listEl) { try { $lr = $listEl.Current.BoundingRectangle } catch { } }
  $o.steps.list = @{ rect = (R2 $lr); percentAtStart = $pct0 }
  if ($o.steps.matchesAtStart -gt 0) { $o.verdict = 'INVALID_TARGET_PRESENT_AT_START' } else {
    $row = $null; $rowTitle = ''; $rowArtist = ''; $rowRect = $null
    foreach ($n in $all0) {
      try {
        if (([string]$n.Current.ControlType.ProgrammaticName) -ne 'ControlType.ListItem') { continue }
        $r = $n.Current.BoundingRectangle
        if (-not $lr) { continue }
        if ($r.Left -lt ($lr.Left - 5) -or $r.Left -gt ($lr.Left + $lr.Width) -or $r.Top -lt ($lr.Top - 5) -or $r.Top -gt ($lr.Top + $lr.Height)) { continue }
        $txt = @()
        foreach ($d in $n.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { try { $t = [string]$d.Current.Name; if ($t) { $txt += $t; if ($txt.Count -ge 4) { break } } } catch { } }
        if (-not $row) { $row = $n; $rowRect = $r; $rowTitle = ($txt -join ' | '); $rowArtist = '' }
      } catch { }
    }
    if (-not $row) { $o.verdict = 'INCONCLUSIVE_NO_LISTITEM_IN_LIST' } else {
      $sip = $null; $hasSip = $false
      try { $hasSip = $row.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$sip) } catch { $hasSip = $false }
      $o.chosenRow = @{ title = (Truncate-AmText $rowTitle 80); rect = (R2 $rowRect); elementValid = [bool]($rowRect -and $rowRect.Width -gt 0); scrollItemPattern = $hasSip }
      if (-not $hasSip) { $o.verdict = 'INCONCLUSIVE_NO_SCROLLITEMPATTERN' } else {
        $err = ''
        $rowsBefore = @(Get-All (Get-AmRoot $app.hwnd).root).Count
        try { $sip.ScrollIntoView() } catch { $err = [string]$_.Exception.GetType().FullName + ' :: ' + [string]$_.Exception.Message }
        Start-Sleep -Seconds 2
        $all1 = Get-All (Get-AmRoot $app.hwnd).root
        $pct1 = -1; if ($listSp) { try { $pct1 = [math]::Round([double]$listSp.Current.VerticalScrollPercent, 1) } catch { } }
        $valid1 = $false; try { $valid1 = [bool]($row.Current.BoundingRectangle.Width -gt 0) } catch { $valid1 = $false }
        $o.call = @{ api = 'ScrollItemPattern.ScrollIntoView'; error = $err; rowsBefore = $rowsBefore; rowsAfter = @($all1).Count; percentBefore = $pct0; percentAfter = $pct1; elementStillValid = $valid1; targetMatchesAfter = (Count-Target $all1) }
        $changed = ($err -eq '' -and ($pct1 -ne $pct0 -or @($all1).Count -ne $rowsBefore))
        $o.after = @{ verifiableChange = $changed; targetMatches = $o.call.targetMatchesAfter }
        if ($err -ne '') { $o.verdict = 'INCONCLUSIVE_SCROLLINTOVIEW_THREW' }
        elseif (-not $changed) { $o.verdict = 'INCONCLUSIVE_NO_VERIFIABLE_CHANGE' }
        elseif ($o.call.targetMatchesAfter -eq 1) { $o.verdict = 'TARGET_REACHED_SINGLE_CALL' }
        else { $o.verdict = 'SCROLLINTOVIEW_WORKS_TARGET_NOT_REACHED' }
      }
    }
  }
}
$json = ($o | ConvertTo-Json -Compress -Depth 8)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json