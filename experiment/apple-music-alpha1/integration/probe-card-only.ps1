# P2 probe: does clicking the album CARD alone start playback, or does it just open the page?
param([string]$AlbumFile, [string]$LabelFile, [string]$SectionFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib' 'am-common.ps1')
. (Join-Path 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib' 'am-smtc.ps1')
. (Join-Path 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib' 'am-uia.ps1')
. (Join-Path 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib' 'am-play.ps1')
. (Join-Path 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib' 'am-play-playlist.ps1')
$album = ([System.IO.File]::ReadAllText($AlbumFile, [System.Text.Encoding]::UTF8)).Trim()
$label = ([System.IO.File]::ReadAllText($LabelFile, [System.Text.Encoding]::UTF8)).Trim()
$section = ([System.IO.File]::ReadAllText($SectionFile, [System.Text.Encoding]::UTF8)).Trim()
$o = [ordered]@{ album = $album; stage = 'UNKNOWN'; smtcBefore = ''; smtcAfterCard = ''; statusAfterCard = ''; clicked = $false; cardName = ''; rowsAfter = 0; firstRows = @() }
$app = Ensure-AmRunning
if ($app.ok) {
  $sb = Get-AmSmtcState; $o.smtcBefore = [string]$sb.title + '|' + [string]$sb.status
  [void](Invoke-AmSearch (Get-AmRoot $app.hwnd).root $album $app.hwnd 6000)
  Start-Sleep -Milliseconds 800
  $chip = Find-AmScopeChip (Get-AmRoot $app.hwnd).root $label
  if ($chip) { [void](Invoke-AmScopeChipSelect $chip) }
  Start-Sleep -Milliseconds 800
  $cand = Get-AmPlaylistCardCandidates (Get-AmRoot $app.hwnd).root $album
  $cards = @($cand.candidates)
  $pick = $null
  foreach ($c in $cards) { foreach ($anc in @($c.ancestors)) { if ($anc -and ([string]$anc).IndexOf($section) -ge 0) { $pick = $c; break } } ; if ($pick) { break } }
  if (-not $pick -and $cards.Count -gt 0) { $pick = $cards[0] }
  if ($pick) {
    $o.cardName = [string]$pick.name
    try { $rect = $pick.element.Current.BoundingRectangle } catch { $rect = $null }
    $pt = Get-AmSafeClickPoint $rect
    $cl = Invoke-AmRowPlay $app.hwnd $pick.element $pt.x $pt.y
    $o.clicked = [bool]$cl.ok
    Start-Sleep -Milliseconds 2500
    $sa = Get-AmSmtcState; $o.smtcAfterCard = [string]$sa.title + '|' + [string]$sa.status
    $o.statusAfterCard = [string]$sa.status
    $root = (Get-AmRoot $app.hwnd).root
    $rows = @(Get-AmListItems $root)
    $o.rowsAfter = $rows.Count
    foreach ($r0 in $rows) { try { $nm = [string]$r0.Current.Name; if ($nm) { $o.firstRows += $nm } } catch { } ; if ($o.firstRows.Count -ge 8) { break } }
    $o.stage = 'PROBED'
  } else { $o.stage = 'NO_CANDIDATE' }
}
$o | ConvertTo-Json -Compress -Depth 5 | Write-Output