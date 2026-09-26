# ============================================================
# poc/lib/am-play-playlist.ps1   (B-i: ADD a playlist capability)
#
# ADDS a capability. It never modifies the existing chain: am-play.ps1, am-uia.ps1,
# am-common.ps1 and am-smtc.ps1 stay byte-identical and are only dot-sourced.
#
# Goal: play ONE of the user's OWN playlists in Apple Music:
#   search the playlist name -> switch the search scope to the LIBRARY tab ->
#   find the playlist CARD whose name matches exactly -> click it.
#
# Why the scope switch matters: the same name can exist in the Apple Music catalogue, and the
# default scope shows that one first (measured by hand). Matching in the wrong scope would play
# a different, same-named playlist.
#
# Ambiguity is never resolved by guessing: 0 matches -> PLAYLIST_NOT_FOUND;
# 2+ matches -> AMBIGUOUS and nothing is clicked.
#
# SAFETY: the default mode is PROBE - nothing is clicked. -Commit performs the click.
# The "did playback start" verification is deliberately NOT wired yet (see the TODO): this slice
# reports exactly what it did and never claims a result it cannot observe.
#
# ASCII-only on purpose: the localized scope label is supplied by the caller via -ScopeLabel.
#
# Stages: APP_NOT_RUNNING, AM_UI_NOT_FOUND, SEARCH_FAILED, SCOPE_CHIP_NOT_FOUND,
#         PLAYLIST_NOT_FOUND, AMBIGUOUS, CARD_NOT_CLICKABLE, PLAYLIST_CLICKED, PROBE_ONLY
# ============================================================

function Find-AmScopeChip($root, [string]$Label) {
  if (-not $Label) { return $null }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($n in $all) {
    try {
      $nm = [string]$n.Current.Name
      if ($nm -and $nm.Trim() -eq $Label.Trim()) { return $n }
    } catch { }
  }
  return $null
}

function Get-AmPlaylistCardCandidates($root, [string]$Name) {
  # Tree-wide: find nodes whose NAME (or text) normalises to the playlist name, then walk up to the nearest
  # clickable ancestor (Invoke or SelectionItem). This deliberately does NOT use Get-AmListItems, which is
  # shaped for song rows. Errors are returned, never swallowed into empty data.
  $want = Normalize-AmText $Name
  $errors = @(); $hits = @()
  $all = $null
  try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
  catch { return @{ ok = $false; errors = @([string]$_.Exception.Message); candidates = @() } }
  foreach ($n in $all) {
    $nm = ''
    try { $nm = [string]$n.Current.Name } catch { continue }
    if (-not $nm) { continue }
    if ((Normalize-AmText $nm) -ne $want) { continue }
    $cur = $n; $clickable = $null
    for ($depth = 0; $depth -lt 6 -and $cur; $depth++) {
      $hit = $false
      try { $o = $null; if ($cur.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { $hit = $true } } catch { }
      if (-not $hit) { try { $o2 = $null; if ($cur.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o2)) { $hit = $true } } catch { } }
      if ($hit) { $clickable = $cur; break }
      try { $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur) } catch { $cur = $null }
    }
    if ($clickable) { $hits += [pscustomobject]@{ element = $clickable; name = $nm } }
  }
  # Dedupe by BOUNDING RECT: one visual card exposes several nested clickable ancestors with the same box,
  # so a runtime-id dedupe over-counts. The surviving count is the number of VISUAL cards (option 4 relies
  # on this index meaning "the Nth matching card on screen").
  $uniq = @(); $seen = @{}
  foreach ($h in $hits) {
    $key = ''
    try {
      $r = $h.element.Current.BoundingRectangle
      $key = ([int]$r.Left).ToString() + ',' + ([int]$r.Top).ToString() + ',' + ([int]$r.Width).ToString() + ',' + ([int]$r.Height).ToString()
    } catch { $key = '' }
    if (-not $key) { $key = 'norect-' + [guid]::NewGuid().ToString() }
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $uniq += [pscustomobject]@{ element = $h.element; name = $h.name; rectKey = $key }
  }
}
function Find-AmPlaylistCards($items, [string]$Name) {
  $want = Normalize-AmText $Name
  $out = @()
  foreach ($it in @($items)) {
    try {
      $nm = [string]$it.Current.Name
      if (-not $nm) { continue }
      if ((Normalize-AmText $nm) -ne $want) { continue }
      $out += [pscustomobject]@{ element = $it; name = $nm; signals = (Get-AmRowSignals $it) }
    } catch { }
  }
  return $out
}

function Invoke-AmPlayPlaylist {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ScopeLabel = '',
    [int]$SearchWaitMs = 6000,
    [switch]$Commit,
    [switch]$HoverProbe,   # read-only: hover the card and dump its subtree, never clicks
    [string]$PlayLabel = '',   # localized play-button label, supplied by the caller (keeps this file ASCII-only)
    [int]$CardIndex = 0,   # option 4: which matching card to pick (1-based); 0 = refuse when ambiguous
    [switch]$DumpItems,
    [switch]$NoLaunch,
    [switch]$NoForeground,
    [string]$ShotPath = ''
  )
  $result = @{
    ok = $false; stage = 'UNKNOWN'; stageDetail = ''; stageHistory = @()
    name = $Name; scopeLabel = $ScopeLabel; mode = $(if ($Commit) { 'commit' } else { 'probe' })
    candidateCount = 0; ambiguous = $false; clicked = $false; cards = @()
    smtc = @{ title = ''; artist = ''; status = '' }
    ts = (Get-AmIsoNow); tsMs = (Get-AmNowMs)
  }
  $stage = 'UNKNOWN'; $detail = ''

  $app = Ensure-AmRunning -TimeoutMs 30000
  $result.appLaunched = [bool]$app.launched
  if (-not $app.ok) { $stage = 'APP_NOT_RUNNING'; $detail = 'launched=' + $app.launched }

  if ($stage -eq 'UNKNOWN') {
    $rootRes = Get-AmRoot $app.hwnd
    if (-not $rootRes.ok) { $stage = 'AM_UI_NOT_FOUND'; $detail = 'tries=' + $rootRes.tries }
  }

  if ($stage -eq 'UNKNOWN') {
    $root = $rootRes.root
    $sr = Invoke-AmSearch $root $Name $app.hwnd $SearchWaitMs
    $result.searchSubmitted = [bool]$sr.submitted
    if (-not $sr.ok) { $stage = 'SEARCH_FAILED'; $detail = [string]$sr.detail }
    else {
      if ($ScopeLabel) {
        $chip = Find-AmScopeChip $root $ScopeLabel
        if (-not $chip) { $stage = 'SCOPE_CHIP_NOT_FOUND'; $detail = 'label=' + $ScopeLabel }
        else {
          try {
            $pt0 = Get-AmSafeClickPoint $chip.Current.BoundingRectangle
            [void](Invoke-AmRowPlay $app.hwnd $chip $pt0.x $pt0.y -NoForeground:$NoForeground)
            Start-Sleep -Milliseconds 1200
            $result.scopeSwitched = $true
          } catch { $stage = 'SCOPE_SWITCH_FAILED'; $detail = $_.Exception.Message }
        }
      }
    }
  }

  if ($stage -eq 'UNKNOWN') {
    $rootFresh = (Get-AmRoot $app.hwnd).root
    $candRes = Get-AmPlaylistCardCandidates $rootFresh $Name
    $cards = @($candRes.candidates)
    $result.dumpErrors = @($candRes.errors)

    $result.candidateCount = $cards.Count
    $result.cards = @($cards | ForEach-Object { @{ name = $_.name; rect = $_.rectKey } })
    if ($DumpItems) {
      $dump = @()
      foreach ($it in @($items)) {
        $nm = ''; $ct = ''; $pats = @(); $txt = @()
        try { $nm = [string]$it.Current.Name } catch { }
        try { $ct = [string]$it.Current.ControlType.ProgrammaticName } catch { }
        foreach ($patId in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.ScrollItemPattern]::Pattern)) {
          try { $obj = $null; if ($it.TryGetCurrentPattern($patId, [ref]$obj)) { $pats += [string]$patId.ProgrammaticName } } catch { }
        }
        try {
          $desc = $it.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
          foreach ($d in $desc) {
            try { if (([string]$d.Current.ControlType.ProgrammaticName) -match 'Text') { $nmv = [string]$d.Current.Name; if ($nmv) { $txt += $nmv; if ($txt.Count -ge 3) { break } } } } catch { }
          }
        } catch { }
        $dump += @{ name = (Truncate-AmText $nm 60); controlType = $ct; patterns = @($pats); text = @($txt) }
        if ($dump.Count -ge 20) { break }
      }
      $result.items = $dump
    }
    if ($cards.Count -eq 0) { $stage = 'PLAYLIST_NOT_FOUND'; $detail = 'listItems=' + @($items).Count }
    elseif ($cards.Count -gt 1 -and $CardIndex -ge 1 -and $CardIndex -le $cards.Count) {
      # option 4: the caller supplies the position; nothing is guessed here.
      $c = $cards[$CardIndex - 1]
      $pt1 = Get-AmSafeClickPoint $c.element.Current.BoundingRectangle
      $ck = Invoke-AmRowPlay $app.hwnd $c.element $pt1.x $pt1.y -NoForeground:$NoForeground
      if ($ck.ok) { $result.clicked = $true; $result.pickedByIndex = $true; $stage = 'PLAYLIST_CLICKED' } else { $stage = 'CARD_NOT_CLICKABLE'; $detail = [string]$ck.detail }
    }
    elseif ($cards.Count -gt 1) { $stage = 'AMBIGUOUS'; $result.ambiguous = $true; $detail = 'cards=' + $cards.Count }
    elseif ($HoverProbe) {
      # read-only: the play button only materializes on hover, so move the cursor onto the card first and
      # then dump what the subtree exposes. Nothing is clicked in this mode.
      $c0 = $cards[0]
      $r0 = $c0.element.Current.BoundingRectangle
      [void](Move-AmCursor ([int]($r0.Left + ($r0.Width / 2))) ([int]($r0.Top + ($r0.Height / 2))))
      Start-Sleep -Milliseconds 700
      $hover = @()
      try {
        $sub = $c0.element.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($d in $sub) {
          $hn = ''; $ht = ''; $hp = @()
          try { $hn = [string]$d.Current.Name } catch { }
          try { $ht = [string]$d.Current.ControlType.ProgrammaticName } catch { }
          foreach ($pat in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern)) {
            try { $oo = $null; if ($d.TryGetCurrentPattern($pat, [ref]$oo)) { $hp += [string]$pat.ProgrammaticName } } catch { }
          }
          if ($hn -or $hp.Count -gt 0) { $hover += @{ name = (Truncate-AmText $hn 50); type = $ht; patterns = @($hp); playLabelHit = [bool]($PlayLabel -and $hn -and ($hn.Trim() -eq $PlayLabel.Trim())) } }
          if ($hover.Count -ge 40) { break }
        }
      } catch { $result.dumpErrors = @($result.dumpErrors) + @([string]$_.Exception.Message) }
      $result.hoverItems = $hover
      $result.playLabel = $PlayLabel
      $stage = 'HOVER_PROBE'; $detail = 'hoverItems=' + @($hover).Count + ' playLabelHit=' + @($hover | Where-Object { $_.playLabelHit }).Count
    }
    elseif (-not $Commit) { $stage = 'PROBE_ONLY'; $detail = 'card found; nothing clicked (pass -Commit to click)' }
    else {
      $c = $cards[0]
      $pt1 = Get-AmSafeClickPoint $c.element.Current.BoundingRectangle
      $ck = Invoke-AmRowPlay $app.hwnd $c.element $pt1.x $pt1.y -NoForeground:$NoForeground
      if (-not $ck.ok) { $stage = 'CARD_NOT_CLICKABLE'; $detail = [string]$ck.detail }
      else {
        $result.clicked = $true; $stage = 'PLAYLIST_CLICKED'
        # TODO(B-i step 4): verify "playback started" through the am-smtc.ps1 state getter once its
        # function name and contract are confirmed by reading that file. Never guess an API.
      }
    }
  }

  $result.stage = $stage; $result.stageDetail = $detail
  $result.ok = ($stage -eq 'PLAYLIST_CLICKED')
  if (-not $result.ok -and $ShotPath) { [void](Save-AmShot $ShotPath) }
  return $result
}
