# Read-only geometry dump: open the album page (card click = navigation only) and show the matched
# row's own rect plus its children (name / control type / rect) so the click can aim deliberately.
param([string]$AlbumFile, [string]$LabelFile, [string]$SectionFile, [string]$TrackFile, [int]$CardIndex = 0)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
. (Join-Path $lib 'am-uia.ps1')
. (Join-Path $lib 'am-play.ps1')
. (Join-Path $lib 'am-play-playlist.ps1')
$album = ([System.IO.File]::ReadAllText($AlbumFile, [System.Text.Encoding]::UTF8)).Trim()
$label = ([System.IO.File]::ReadAllText($LabelFile, [System.Text.Encoding]::UTF8)).Trim()
$section = ([System.IO.File]::ReadAllText($SectionFile, [System.Text.Encoding]::UTF8)).Trim()
$track = ([System.IO.File]::ReadAllText($TrackFile, [System.Text.Encoding]::UTF8)).Trim()
$app = Ensure-AmRunning
$o = [ordered]@{ track = $track; cards = 0; clickedCard = 0; rowRect = ''; children = @(); patterns = '' }
[void](Invoke-AmSearch (Get-AmRoot $app.hwnd).root $album $app.hwnd 6000)
Start-Sleep -Milliseconds 800
$chip = Find-AmScopeChip (Get-AmRoot $app.hwnd).root $label
if ($chip) { [void](Invoke-AmScopeChipSelect $chip) }
Start-Sleep -Milliseconds 800
$cand = Get-AmPlaylistCardCandidates (Get-AmRoot $app.hwnd).root $album
$cards = @($cand.candidates)
$sec = @()
foreach ($c in $cards) { foreach ($anc in @($c.ancestors)) { if ($anc -and ([string]$anc).IndexOf($section) -ge 0) { $sec += $c; break } } }
if (@($sec).Count -eq 0) { $sec = $cards }
$o.cards = @($sec).Count
$idx = $(if ($CardIndex -ge 1 -and $CardIndex -le @($sec).Count) { $CardIndex } else { 1 })
if (@($sec).Count -ge $idx) {
  $pick = $sec[$idx - 1]
  try { $r0 = $pick.element.Current.BoundingRectangle } catch { $r0 = $null }
  $p0 = Get-AmSafeClickPoint $r0
  [void](Invoke-AmRowPlay $app.hwnd $pick.element $p0.x $p0.y)
  $o.clickedCard = $idx
  Start-Sleep -Milliseconds 1800
  $root = (Get-AmRoot $app.hwnd).root
  $want = Normalize-AmText $track
  $all = $null
  try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } catch { }
  foreach ($n in @($all)) {
    $nm = ''
    try { $nm = [string]$n.Current.Name } catch { continue }
    if (-not $nm -or (Normalize-AmText $nm).IndexOf($want) -lt 0) { continue }
    $cur = $n; $row = $null
    for ($d = 0; $d -lt 8 -and $cur; $d++) {
      try { $ct = [string]$cur.Current.ControlType.ProgrammaticName } catch { $ct = '' }
      if ($ct -eq 'ControlType.ListItem') { $row = $cur; break }
      try { $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur) } catch { $cur = $null }
    }
    if (-not $row) { continue }
    try { $rr = $row.Current.BoundingRectangle; $o.rowRect = ('' + [int]$rr.Left + ',' + [int]$rr.Top + ' ' + [int]$rr.Width + 'x' + [int]$rr.Height) } catch { }
    $pats = @()
    foreach ($pid in @([System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.InvokePattern]::Pattern)) {
      try { $ob = $null; if ($row.TryGetCurrentPattern($pid, [ref]$ob)) { $pats += [string]$pid.ProgrammaticName } } catch { }
    }
    $o.patterns = ($pats -join ',')
    $kids = @()
    try {
      $desc = $row.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($dd in $desc) {
        $dn = ''; $dt = ''; $dr = ''
        try { $dn = [string]$dd.Current.Name } catch { }
        try { $dt = [string]$dd.Current.ControlType.ProgrammaticName } catch { }
        try { $b = $dd.Current.BoundingRectangle; $dr = ('' + [int]$b.Left + ',' + [int]$b.Top + ' ' + [int]$b.Width + 'x' + [int]$b.Height) } catch { }
        $kids += @{ name = (Truncate-AmText $dn 28); type = ($dt -replace 'ControlType.', ''); rect = $dr }
        if ($kids.Count -ge 14) { break }
      }
    } catch { }
    $o.children = $kids
    break
  }
}
$o | ConvertTo-Json -Compress -Depth 6 | Write-Output