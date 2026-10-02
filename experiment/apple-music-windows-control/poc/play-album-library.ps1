# ============================================================
# poc/play-album-library.ps1   (NEW, non-frozen wrapper)
#
# Library album playback with SECTION-AWARE disambiguation.
# The frozen playlist engine already searches, force-selects the library scope chip and verifies it,
# but it refuses to guess when the name matches more than one card - and an album search is always
# ambiguous on Apple Music (album card 'Starboy' + song row 'Starboy (feat. Daft Punk)').
# So: probe first (nothing clicked), keep the candidate that sits in the album section (localized
# label passed in by the caller - this file stays ASCII-only), then commit THAT CardIndex.
# If no candidate sits in the section, the probe's AMBIGUOUS verdict is returned unchanged: no guessing.
#
# Usage: powershell -File poc\play-album-library.ps1 -Name "Starboy" -ScopeLabel <lib label> -SectionLabel <album label> -Commit
# ============================================================
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$ScopeLabel = '',
  [string]$SectionLabel = '',
  [string]$Url = '',
  [int]$SearchWaitMs = 6000,
  [int]$SmtcTimeoutMs = 8000,
  [switch]$Commit,
  [string]$TrackTitle = '',
  [switch]$DumpItems
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot 'lib\am-uia.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play-playlist.ps1')

$probeArgs = @{ Name = $Name; ScopeLabel = $ScopeLabel; SearchWaitMs = $SearchWaitMs }
if ($Url) { $probeArgs['Url'] = $Url }
if ($DumpItems) { $probeArgs['DumpItems'] = $true }
$probe = Invoke-AmPlayPlaylist @probeArgs
$cards = @($probe.cards)
$pick = 0; $pickedName = ''; $pickedSection = ''; $disambiguation = ''
if ($cards.Count -eq 0) { $disambiguation = 'no-candidate' }
elseif ($cards.Count -eq 1) { $pick = 1; $pickedName = [string]$cards[0].name; $disambiguation = 'single' }
else {
  if ($SectionLabel) {
    for ($i = 0; $i -lt $cards.Count; $i++) {
      $hit = $false
      foreach ($anc in @($cards[$i].ancestors)) {
        if ($anc -and ([string]$anc).IndexOf($SectionLabel) -ge 0) { $hit = $true; break }
      }
      if ($hit) { $pick = $i + 1; $pickedName = [string]$cards[$i].name; $pickedSection = $SectionLabel; $disambiguation = 'section-match'; break }
    }
  }
  # 按用户约定：没有分区匹配时直接取第一个候选，不再拒绝执行
  if ($pick -eq 0) { $pick = 1; $pickedName = [string]$cards[0].name; $disambiguation = 'first-fallback' }
}
$final = $probe
if ($Commit -and $pick -ge 1 -and -not $TrackTitle) {
  $commitArgs = @{ Name = $Name; ScopeLabel = $ScopeLabel; SearchWaitMs = $SearchWaitMs; CardIndex = $pick; Commit = $true; SmtcTimeoutMs = $SmtcTimeoutMs }
  if ($Url) { $commitArgs['Url'] = $Url }
  # The frozen engine minimizes Apple Music right after a successful play click, which makes the album
  # page unenumerable for UIA. In track mode keep it in front until the row has been clicked.
  if ($TrackTitle) { $commitArgs['NoMinimize'] = $true }
  # The frozen engine minimizes Apple Music right after a successful play click; that makes the album
  $final = Invoke-AmPlayPlaylist @commitArgs
}
$o = [ordered]@{}
foreach ($k in $final.Keys) { $o[$k] = $final[$k] }
$o['candidateCount'] = $cards.Count
$o['pickedIndex'] = $pick
$o['pickedName'] = $pickedName
$o['pickedSection'] = $pickedSection
$o['disambiguation'] = $disambiguation
$o['probeStage'] = [string]$probe.stage

# --- track mode: the engine cannot find a SONG by title (its card matcher is exact-name only),
# so we open the album page first and click the matching ROW inside the opened page. ---
if ($TrackTitle -and $Commit) {
  Start-Sleep -Milliseconds 2200
  # P2: open the album page WITHOUT playing anything - the card click navigates only (measured: SMTC stays
  # unchanged), so the requested track can be clicked straight away instead of hearing track 1 first.
  $app2 = Ensure-AmRunning
  [void](Invoke-AmSearch (Get-AmRoot $app2.hwnd).root $Name $app2.hwnd $SearchWaitMs)
  Start-Sleep -Milliseconds 800
  $chip2 = Find-AmScopeChip (Get-AmRoot $app2.hwnd).root $ScopeLabel
  if ($chip2) { [void](Invoke-AmScopeChipSelect $chip2) }
  Start-Sleep -Milliseconds 800
  $candRes = Get-AmPlaylistCardCandidates (Get-AmRoot $app2.hwnd).root $Name
  $cardList = @($candRes.candidates)
  $cardPick = $null
  if ($SectionLabel) {
    foreach ($cc in $cardList) { foreach ($anc in @($cc.ancestors)) { if ($anc -and ([string]$anc).IndexOf($SectionLabel) -ge 0) { $cardPick = $cc; break } } ; if ($cardPick) { break } }
  }
  if (-not $cardPick -and $cardList.Count -gt 0) { $cardPick = $cardList[0] }
  $o['pageCardCount'] = $cardList.Count
  $o['pageCardClicked'] = $false
  if ($cardPick) {
    try { $cardRect = $cardPick.element.Current.BoundingRectangle } catch { $cardRect = $null }
    $cardPt = Get-AmSafeClickPoint $cardRect
    $cardClick = Invoke-AmRowPlay $app2.hwnd $cardPick.element $cardPt.x $cardPt.y
    $o['pageCardClicked'] = [bool]$cardClick.ok
    Start-Sleep -Milliseconds 1800
  }
  $rootT = (Get-AmRoot $app2.hwnd).root
  $want = Normalize-AmText $TrackTitle
  # Get-AmListItems returns nameless items for this page (same as the search results page), so scan the
  # WHOLE tree for nodes whose name contains the track title and walk up to the nearest clickable ancestor
  # (the same pattern the frozen playlist engine uses for cards).
  $dump = @(); $hits = @()
  $all = $null
  try { $all = $rootT.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } catch { $all = @() }
  foreach ($n in @($all)) {
    $nm = ''
    try { $nm = [string]$n.Current.Name } catch { continue }
    if (-not $nm) { continue }
    if ((Normalize-AmText $nm).IndexOf($want) -lt 0) { continue }
    $cur = $n; $clickable = $null
    for ($depth = 0; $depth -lt 6 -and $cur; $depth++) {
      try {
        $obj = $null
        $okInv = $false; $okSel = $false
        try { $okInv = $cur.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$obj) } catch { }
        if (-not $okInv) { try { $obj = $null; $okSel = $cur.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$obj) } catch { } }
        if ($okInv -or $okSel) { $clickable = $cur; break }
      } catch { }
      try { $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur) } catch { $cur = $null }
    }
    if ($dump.Count -lt 40) { $dump += @{ name = (Truncate-AmText $nm 60); clickable = [bool]$clickable } }
    if ($clickable) { $hits += $clickable }
  }
  $o['trackRows'] = @($dump)
  $o['trackRowCount'] = @($dump).Count
  $hit = $null
  if (@($hits).Count -gt 0) { $hit = $hits[0]; $hitName = [string]$dump[0].name }
  $o['trackMatched'] = [bool]$hit
  if (-not $hit) {
    # The page exposes no matching row (podcast-style releases): fall back to playing the whole album
    # so the click still produces sound. The stage stays honest - the exact track could not be located.
    $fbIndex = $(if ($pick -ge 1) { $pick } else { 1 })
    $fb = Invoke-AmPlayPlaylist -Name $Name -ScopeLabel $ScopeLabel -SearchWaitMs $SearchWaitMs -CardIndex $fbIndex -Commit -SmtcTimeoutMs $SmtcTimeoutMs
    $o['fallbackStage'] = [string]$fb.stage
    $o['stage'] = 'TRACK_ROW_NOT_FOUND'
    $o['ok'] = $false
  }
  else {
    try { [void](Realize-AmRow $hit 2500 120 $app2.hwnd) } catch { }
    $rectT = $null; try { $rectT = $hit.Current.BoundingRectangle } catch { }
    $ptT = Get-AmSafeClickPoint $rectT
    $clickT = Invoke-AmRowPlay $app2.hwnd $hit $ptT.x $ptT.y
    $o['trackClicked'] = [bool]$clickT.ok
    $deadlineT = (Get-Date).AddMilliseconds($SmtcTimeoutMs)
    $okT = $false
    while ((Get-Date) -lt $deadlineT) {
      Start-Sleep -Milliseconds 400
      $sT = Get-AmSmtcState
      if ($sT.ok -and (Normalize-AmText ([string]$sT.title)).IndexOf($want) -ge 0) { $o['smtcTitle'] = [string]$sT.title; $okT = $true; break }
    }
    if ($okT) { $o['stage'] = 'PLAYBACK_STARTED'; $o['ok'] = $true }
    else { $o['stage'] = 'TRACK_CLICKED_UNVERIFIED'; $o['ok'] = $false }
  }
}
$o | ConvertTo-Json -Compress -Depth 6 | Write-Output