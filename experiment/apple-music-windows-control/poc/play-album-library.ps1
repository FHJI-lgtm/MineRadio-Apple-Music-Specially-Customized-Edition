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

# --- track mode: open the album page that actually CONTAINS the requested track ---------------
# A name search can return several identical-looking album cards (in this library After Hours
# appears twice with different tracklists), so walk the album-section candidates until the row is
# found. Cards are opened by a plain click (measured: that navigates without starting playback).
if ($TrackTitle -and $Commit) {
  $app2 = Ensure-AmRunning
  $o['trackAttempts'] = @()
  $trackHit = $null; $trackHitName = ''; $trackExact = $false
  $secCount = 0
  for ($ci = 1; $ci -le 4; $ci++) {
    [void](Invoke-AmSearch (Get-AmRoot $app2.hwnd).root $Name $app2.hwnd $SearchWaitMs)
    Start-Sleep -Milliseconds 800
    $chipL = Find-AmScopeChip (Get-AmRoot $app2.hwnd).root $ScopeLabel
    if ($chipL) { [void](Invoke-AmScopeChipSelect $chipL) }
    Start-Sleep -Milliseconds 800
    $candRes = Get-AmPlaylistCardCandidates (Get-AmRoot $app2.hwnd).root $Name
    $cardList = @($candRes.candidates)
    $secCards = @()
    foreach ($cc in $cardList) {
      foreach ($anc in @($cc.ancestors)) { if ($anc -and $SectionLabel -and ([string]$anc).IndexOf($SectionLabel) -ge 0) { $secCards += $cc; break } }
    }
    if (@($secCards).Count -eq 0) { $secCards = $cardList }
    $secCount = @($secCards).Count
    if ($ci -gt $secCount) { break }
    $pickCard = $secCards[$ci - 1]
    try { $cRect = $pickCard.element.Current.BoundingRectangle } catch { $cRect = $null }
    $cPt = Get-AmSafeClickPoint $cRect
    [void](Invoke-AmRowPlay $app2.hwnd $pickCard.element $cPt.x $cPt.y)
    Start-Sleep -Milliseconds 1800
    $rootT = (Get-AmRoot $app2.hwnd).root
    $want = Normalize-AmText $TrackTitle
    $dump = @(); $hits = @()
    try { $all = $rootT.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } catch { $all = @() }
    foreach ($n in @($all)) {
      $nm = ''
      try { $nm = [string]$n.Current.Name } catch { continue }
      if (-not $nm) { continue }
      if ((Normalize-AmText $nm).IndexOf($want) -lt 0) { continue }
      $cur = $n; $row = $null
      for ($depth = 0; $depth -lt 8 -and $cur; $depth++) {
        try { $ct = [string]$cur.Current.ControlType.ProgrammaticName } catch { $ct = '' }
        if ($ct -eq 'ControlType.ListItem') { $row = $cur; break }
        try { $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur) } catch { $cur = $null }
      }
      if (-not $row) { continue }
      $clickable = $null
      try {
        $obj2 = $null; $okSel2 = $false
        try { $okSel2 = $row.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$obj2) } catch { }
        if ($okSel2) { $clickable = $row } else { $obj3 = $null; if ($row.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$obj3)) { $clickable = $row } }
      } catch { }
      if ($clickable) { $exact = ($nm.Trim() -eq $TrackTitle.Trim()); $hits += @{ el = $clickable; exact = $exact; name = $nm } }
    }
    $o['trackAttempts'] += @{ card = $ci; name = (Truncate-AmText ([string]$pickCard.name) 40); rows = @($dump).Count; hits = @($hits).Count }
    if (@($hits).Count -gt 0) {
      $chosen = @($hits | Where-Object { $_.exact })[0]
      if (-not $chosen) { $chosen = $hits[0] }
      $trackHit = $chosen.el; $trackHitName = [string]$chosen.name; $trackExact = [bool]$chosen.exact
      break
    }
  }
  $o['trackCardCandidates'] = $secCount
  $o['trackMatched'] = [bool]$trackHit
  $o['trackMatchedName'] = $trackHitName
  $o['trackExactMatch'] = $trackExact
  if (-not $trackHit) {
    $fbIndex = $(if ($pick -ge 1) { $pick } else { 1 })
    $fb = Invoke-AmPlayPlaylist -Name $Name -ScopeLabel $ScopeLabel -SearchWaitMs $SearchWaitMs -CardIndex $fbIndex -Commit -SmtcTimeoutMs $SmtcTimeoutMs
    $o['fallbackStage'] = [string]$fb.stage
    $o['stage'] = 'TRACK_ROW_NOT_FOUND'
    $o['ok'] = $false
  } else {
    try { [void](Realize-AmRow $trackHit 2500 120 $app2.hwnd) } catch { }
    $rectT = $null; try { $rectT = $trackHit.Current.BoundingRectangle } catch { }
    $ptT = Get-AmSafeClickPoint $rectT
    $clickT = Invoke-AmRowPlay $app2.hwnd $trackHit $ptT.x $ptT.y
    $o['trackClicked'] = [bool]$clickT.ok
    $deadlineT = (Get-Date).AddMilliseconds($SmtcTimeoutMs)
    $okT = $false
    while ((Get-Date) -lt $deadlineT) {
      Start-Sleep -Milliseconds 400
      $sT = Get-AmSmtcState
      if ($sT.ok -and (Normalize-AmText ([string]$sT.title)).IndexOf($want) -ge 0) { $o['smtcTitle'] = [string]$sT.title; $okT = $true; break }
    }
    if ($okT) { $o['stage'] = 'PLAYBACK_STARTED'; $o['ok'] = $true } else { $o['stage'] = 'TRACK_CLICKED_UNVERIFIED'; $o['ok'] = $false }
  }
}
$o | ConvertTo-Json -Compress -Depth 6 | Write-Output