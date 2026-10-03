# STEP 1 probe (read-only): open the playlist page via the verified route, then enumerate its header buttons.
# NO click on play/shuffle/rows. Only the card click used for NAVIGATION.
param([string]$PlaylistFile, [string]$ScopeFile, [string]$OutFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function RT([string]$p) { return ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)).Trim() }
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
. (Join-Path $lib 'am-uia.ps1')
. (Join-Path $lib 'am-play.ps1')
. (Join-Path $lib 'am-play-playlist.ps1')
$pl = RT $PlaylistFile; $scope = RT $ScopeFile
$o = [ordered]@{ playlist = $pl; steps = [ordered]@{}; buttons = @(); idButtons = @() }
$app = Ensure-AmRunning
[void](Invoke-AmForeground $app.hwnd)
$s0 = Get-AmSmtcState
$o.steps.before = @{ status = [string]$s0.status; title = [string]$s0.title }
[void](Invoke-AmSearch (Get-AmRoot $app.hwnd).root $pl $app.hwnd 6000)
Start-Sleep -Milliseconds 900
$chip = Find-AmScopeChip (Get-AmRoot $app.hwnd).root $scope
if ($chip) { [void](Invoke-AmScopeChipSelect $chip) }
Start-Sleep -Milliseconds 900
$cards = @((Get-AmPlaylistCardCandidates (Get-AmRoot $app.hwnd).root $pl).candidates)
$exact = @($cards | Where-Object { (Normalize-AmText ([string]$_.name)) -eq (Normalize-AmText $pl) })
$pick = $null ; if ($exact.Count -eq 1) { $pick = $exact[0] } elseif ($cards.Count -eq 1) { $pick = $cards[0] }
$o.steps.search = @{ candidates = $cards.Count; exactMatches = $exact.Count; picked = [bool]$pick }
if ($pick) {
  try { $cr = $pick.element.Current.BoundingRectangle } catch { $cr = $null }
  $cp = Get-AmSafeClickPoint $cr
  $o.steps.navigate = @{ ok = [bool](Invoke-AmRowPlay $app.hwnd $pick.element $cp.x $cp.y).ok }
  Start-Sleep -Seconds 3
  $s1 = Get-AmSmtcState
  $o.steps.afterNavigate = @{ status = [string]$s1.status; title = [string]$s1.title; playbackChanged = (([string]$s1.title) -ne ([string]$s0.title)) }
  $all = @(); try { $all = @((Get-AmRoot $app.hwnd).root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) } catch { }
  $o.steps.nodes = @($all).Count
  foreach ($n in $all) {
    try {
      $ct = [string]$n.Current.ControlType.ProgrammaticName
      if ($ct -notmatch 'Button') { continue }
      $nm = ([string]$n.Current.Name).Trim()
      $aid = [string]$n.Current.AutomationId
      $pats = @(); $tstate = ''
      foreach ($pp in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern)) {
        try { $ob = $null; if ($n.TryGetCurrentPattern($pp, [ref]$ob)) { $pats += ([string]$pp.ProgrammaticName -replace 'PatternIdentifiers.Pattern','') ; if ($pp -eq [System.Windows.Automation.TogglePattern]::Pattern) { try { $tstate = [string]$ob.Current.ToggleState } catch { } } } } catch { }
      }
      $rect = ''; try { $r2 = $n.Current.BoundingRectangle; $rect = ('' + [int]$r2.Left + ',' + [int]$r2.Top + ' ' + [int]$r2.Width + 'x' + [int]$r2.Height) } catch { }
      $row = @{ name = $nm; automationId = $aid; controlType = $ct; patterns = @($pats); toggleState = $tstate; rect = $rect }
      if ($nm -or $aid) { $o.buttons += $row }
      if ($aid) { $o.idButtons += $row }
    } catch { }
  }
}
$json = ($o | ConvertTo-Json -Compress -Depth 7)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json