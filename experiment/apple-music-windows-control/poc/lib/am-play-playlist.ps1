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
# SAFETY: the default mode is PROBE - nothing is clicked (-CardIndex included: it only selects).
# -Commit performs the click.
# Playback entry (measured): the card's OWN hover play button (bottom-left overlay, AutomationId=PlayButton)
# starts it directly; clicking the card body only navigates and is kept as a fallback.
# "Did playback start" IS wired now (B-i step 4): SMTC before/after the click, and the only success is a
# transition to Playing. A playlist has no expected track title, so Wait-AmPlayback(Title,Artist) cannot be
# used without inventing a title; the honest criterion is the transition (see the commit branch).
#
# ASCII-only on purpose: the localized scope label is supplied by the caller via -ScopeLabel.
#
# Stages: APP_NOT_RUNNING, AM_UI_NOT_FOUND, SEARCH_FAILED, SCOPE_CHIP_NOT_FOUND, SCOPE_SWITCH_FAILED,
#         PLAYLIST_NOT_FOUND, AMBIGUOUS, CARD_NOT_CLICKABLE, PLAY_BUTTON_NOT_FOUND, URL_NAVIGATION_FAILED,
#         PROBE_ONLY, HOVER_PROBE,
#         PLAYBACK_STARTED (ok), PLAYBACK_UNCHANGED, SMTC_TIMEOUT, PLAYLIST_CLICKED (clicked, no SMTC
#         session to verify against). Only PLAYBACK_STARTED sets ok=true.
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

function Get-AmScopeChipState($chip) {
  # 读 chip 自身的开关状态。这是**唯一可信**的范围判据：
  # chip 是 TogglePattern 按钮（REPORT-B-I-PLAYLIST-CARD.md 4.1，AutomationId=SearchLibrary），
  # 切换语义意味着"再点一次是关掉" —— 盲点会把已开启的范围点回 Apple Music 全局范围。
  # 返回 'On' / 'Off' / ''（读不到）。
  if (-not $chip) { return '' }
  try {
    $obj = $null
    if ($chip.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$obj)) {
      $st = $obj.Current.ToggleState
      if ($st -eq [System.Windows.Automation.ToggleState]::On) { return 'On' }
      if ($st -eq [System.Windows.Automation.ToggleState]::Off) { return 'Off' }
      return 'Indeterminate'
    }
  } catch { }
  return ''
}

function Invoke-AmScopeChipSelect($chip) {
  # 按状态确保 chip 处于 On。已经是 On 就不点（避免把它关掉）。
  # 读不到状态时退回盲点（与既有行为一致），由调用方的结果验证兜底。
  $before = Get-AmScopeChipState $chip
  if ($before -eq 'On') { return @{ clicked = $false; stateBefore = $before; stateAfter = $before; reason = 'already-on' } }
  try {
    $obj = $null
    if ($chip.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$obj)) {
      $obj.Toggle()
    } else {
      return @{ clicked = $false; stateBefore = $before; stateAfter = $before; reason = 'no-toggle-pattern' }
    }
  } catch {
    return @{ clicked = $false; stateBefore = $before; stateAfter = $before; reason = 'toggle-threw' }
  }
  Start-Sleep -Milliseconds 200
  $after = Get-AmScopeChipState $chip
  return @{ clicked = $true; stateBefore = $before; stateAfter = $after; reason = 'toggled' }
}

function Get-AmPlaylistCardCandidates($root, [string]$Name, [switch]$EarlyExitOnAmbiguous) {
  # Tree-wide: find nodes whose NAME (or text) normalises to the playlist name, then walk up to the nearest
  # clickable ancestor (Invoke or SelectionItem). This deliberately does NOT use Get-AmListItems, which is
  # shaped for song rows. Errors are returned, never swallowed into empty data.
  $want = Normalize-AmText $Name
  $errors = @(); $hits = @(); $earlyExit = $false; $earlyExitAt = 0
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
    if ($clickable) {
      # Region-first exclusion (measured root cause): the QUERY STRING itself sits in the search box at the
      # top-left, so a plain text match lands there - the cursor then stops on the scope chip and any click
      # does nothing. So: never accept the search control, and only accept a card that lies BELOW the search
      # box and to the RIGHT of it (which also excludes the sliding left sidebar overlay seen while searching).
      $selfCt = ''
      try { $selfCt = [string]$clickable.Current.ControlType.ProgrammaticName } catch { }
      if ($selfCt -match 'Edit|Document') { continue }
      # Find-AmEnabledEdit returns @{ element; count; index }, NOT the element itself: reading
      # .Current off the hashtable threw and the surrounding catch swallowed it, so this region
      # exclusion silently never ran.
      $box = $null
      try { $box = (Find-AmEnabledEdit $root).element } catch { }
      if ($box) {
        try {
          $br = $box.Current.BoundingRectangle
          $clickRect = $clickable.Current.BoundingRectangle
          if ($clickRect.Top -lt ($br.Top + $br.Height)) { continue }
          if ($clickRect.Left -lt ($br.Left + $br.Width)) { continue }
        } catch { }
      }
      # NO cover-Image gate here: it was tried and REFUTED by measurement (2026-09-26, live app).
      # A search-result playlist CARD exposes ONLY { ListItem, Group, Text x2 } in its UIA subtree
      # (4 nodes, 0 Image at any depth) - the artwork is not surfaced as a UIA Image control. So
      # 'must contain a cover Image' rejected 10/10 exact-name matches, INCLUDING both genuine result
      # cards, and the engine reported 0 candidates where the truth was 2. What actually separates a
      # result card from the sidebar/nav is the REGION test above: sidebar rows sit at x 5..502 (left of
      # the search box, whose bottom-right is ~491,145) and the scope chips at y~131 (above it).
      # Self-evidence for the hit: its own type/rect plus 3 ancestor levels. This tells us immediately whether
      # the name matched a result CARD or something else that merely carries the same text (search box, sidebar).
      $selfType = ''; $selfRect = ''
      try { $selfType = [string]$clickable.Current.ControlType.ProgrammaticName } catch { }
      try {
        $rr = $clickable.Current.BoundingRectangle
        $selfRect = ([int]$rr.Left).ToString() + ',' + ([int]$rr.Top).ToString() + ',' + ([int]$rr.Width).ToString() + ',' + ([int]$rr.Height).ToString()
      } catch { }
      $anc = @()
      try {
        $up = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($clickable)
        for ($lvl = 0; $lvl -lt 3 -and $up; $lvl++) {
          $an = ''; $at = ''; $ar = ''
          try { $an = (Truncate-AmText ([string]$up.Current.Name) 30) } catch { }
          try { $at = [string]$up.Current.ControlType.ProgrammaticName } catch { }
          try {
            $q = $up.Current.BoundingRectangle
            $ar = ([int]$q.Left).ToString() + ',' + ([int]$q.Top).ToString() + ',' + ([int]$q.Width).ToString() + ',' + ([int]$q.Height).ToString()
          } catch { }
          $anc += ($at + ' name=' + $an + ' rect=' + $ar)
          try { $up = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($up) } catch { $up = $null }
        }
      } catch { }
      $hits += [pscustomobject]@{ element = $clickable; name = $nm; selfType = $selfType; selfRect = $selfRect; ancestors = @($anc) }
    }
  }
  # Dedupe by BOUNDING RECT: one visual card exposes several nested clickable ancestors with the same box,
  # so a runtime-id dedupe over-counts. The surviving count is the number of VISUAL cards (option 4 relies
  # on this index meaning "the Nth matching card on screen").
  $uniq = @(); $seenRects = @()
  foreach ($h in $hits) {
    $key = ''
    try {
      $r = $h.element.Current.BoundingRectangle
      $key = ([int]$r.Left).ToString() + ',' + ([int]$r.Top).ToString() + ',' + ([int]$r.Width).ToString() + ',' + ([int]$r.Height).ToString()
    } catch { $key = '' }
    if (-not $key) { $key = 'norect-' + [guid]::NewGuid().ToString() }
    else {
      # TOLERANT rect dedupe. An exact-string key let the SAME visual card through twice when the two
      # elements differed by 1px: measured twice in the catalogue scope ONE snapshot held both
      # 573,297,367,483 and 573,297,367,482, i.e. a phantom AMBIGUOUS on a scope holding 2 cards.
      # Two genuinely different cards are never within 2px of each other, so merge a <=2px box difference.
      $p = @($key -split ',')
      $dupe = $false
      foreach ($s in $seenRects) {
        if ([Math]::Abs($s[0] - [int]$p[0]) -le 2 -and [Math]::Abs($s[1] - [int]$p[1]) -le 2 -and [Math]::Abs($s[2] - [int]$p[2]) -le 2 -and [Math]::Abs($s[3] - [int]$p[3]) -le 2) { $dupe = $true; break }
      }
      if ($dupe) { continue }
      $seenRects += ,@([int]$p[0], [int]$p[1], [int]$p[2], [int]$p[3])
    }
    $uniq += [pscustomobject]@{
      element = $h.element; name = $h.name; rectKey = $key
      selfType = $h.selfType; selfRect = $h.selfRect; ancestors = @($h.ancestors)
    }
    # EARLY EXIT (ambiguity): without -CardIndex the caller can never use more than two distinct
    # candidates - this function's contract is 0 -> PLAYLIST_NOT_FOUND, 2+ -> AMBIGUOUS and nothing is
    # clicked. Enumerating the remaining matches cost one full UIA walk each (name read + up to 6
    # pattern probes + ~4 property reads + 3 ancestor levels per match), which is the multi-result
    # stall. Two DISTINCT deduped rects already prove ambiguity, so stop here. Disabled when the caller
    # may pick by index, because -CardIndex needs the complete list preserved.
    if ($EarlyExitOnAmbiguous -and $uniq.Count -ge 2) {
      $earlyExit = $true; $earlyExitAt = $uniq.Count
      break
    }
  }
  # CONTRACT: one object { ok; errors; candidates } - the catch path above already returns that shape and
  # both callers read .candidates. Returning the bare $uniq array instead made @($res.candidates) collapse
  # to @($null) (PowerShell yields nothing for a member no element has, and @($null) has Count 1), so
  # 'nothing matched' AND 'two matched' both arrived as a single NULL card - a PROBE_ONLY false positive.
  return @{ ok = $true; errors = @($errors); candidates = @($uniq); earlyExit = [bool]$earlyExit; earlyExitAt = [int]$earlyExitAt }
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

function Refind-AmPlaylistCard($root, [string]$Name, [string]$RectKey) {
  # UI Automation elements go stale the moment the page repaints - and hovering a card repaints it. So the
  # card must be re-located (fresh root + fresh candidates) right before anything is read or clicked.
  # Matching: exact rectangle first, otherwise the candidate whose top-left is closest to the recorded one.
  $res = Get-AmPlaylistCardCandidates $root $Name
  $cands = @($res.candidates)
  if ($cands.Count -eq 0) { return $null }
  if ($RectKey) {
    foreach ($c in $cands) { if ($c.rectKey -eq $RectKey) { return $c } }
    $want = @($RectKey -split ',')
    $best = $null; $bestScore = -1
    foreach ($c in $cands) {
      $p = @($c.rectKey -split ',')
      if ($p.Count -lt 4) { continue }
      $dx = [Math]::Abs(([int]$p[0]) - ([int]$want[0]))
      $dy = [Math]::Abs(([int]$p[1]) - ([int]$want[1]))
      $score = 1000000 - ($dx + $dy)
      if ($score -gt $bestScore) { $bestScore = $score; $best = $c }
    }
    if ($best) { return $best }
  }
  return $cands[0]
}

# ------------------------------------------------------------
# B-i step 4: SMTC transition + the playlist page's play button
# ------------------------------------------------------------

function Hide-AmAfterClick([IntPtr]$Hwnd, [switch]$NoMinimize) {
  # Same order as the verified song chain (am-play.ps1:307-310): let the click land (250ms), hand the
  # screen back, and only THEN verify through SMTC. Reuses the song chain's own Minimize-AmWindow when
  # the caller dot-sourced am-play.ps1; if that file is not loaded this returns false and nothing else
  # changes (the engine stays usable on its own).
  if ($NoMinimize) { return $false }
  Start-Sleep -Milliseconds 250
  if (-not (Get-Command Minimize-AmWindow -ErrorAction SilentlyContinue)) { return $false }
  try { return [bool](Minimize-AmWindow $Hwnd) } catch { return $false }
}

function Invoke-AmSingleClick([IntPtr]$Hwnd, $Element, [int]$X, [int]$Y, [switch]$NoForeground) {
  # EXACTLY ONE synthesized click (one down/up pair), with the same foreground + geometry-recompute
  # discipline as the frozen Invoke-AmRowPlay.
  # WHY: user-reported and measured (2026-09-26) - in Apple Music the FIRST click on a play control really
  # starts playback (after a short load), while clicking play AGAIN PAUSES it. The frozen Invoke-AmRowPlay
  # sends a DOUBLE click because it is built for song ROWS, so on a play/pause control it is play-then-pause.
  # That is exactly why the card's hover play button looked "found, clicked, but playback never started".
  # The frozen file is NOT touched; every play-control click in this file goes through here instead.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $usedX = $X; $usedY = $Y
  try {
    if (-not $NoForeground) {
      Invoke-AmForeground $Hwnd
      Start-Sleep -Milliseconds 350
    }
    if ($Element) {
      try {
        $r2 = $Element.Current.BoundingRectangle
        if (Test-AmRectSane $r2) { $pt2 = Get-AmSafeClickPoint $r2; $usedX = $pt2.x; $usedY = $pt2.y }
      } catch { }
    }
    [void][AmUiaNative]::SetCursorPos($usedX, $usedY)
    Start-Sleep -Milliseconds 200
    [AmUiaNative]::mouse_event(2, 0, 0, 0, 0)
    [AmUiaNative]::mouse_event(4, 0, 0, 0, 0)
  } catch {
    return @{ ok = $false; stage = 'CLICK_FAILED'; ms = [int]$sw.ElapsedMilliseconds; detail = $_.Exception.Message; x = $usedX; y = $usedY; clicks = 1 }
  }
  return @{ ok = $true; stage = 'OK'; ms = [int]$sw.ElapsedMilliseconds; detail = ''; x = $usedX; y = $usedY; clicks = 1 }
}

function Find-AmInCardPlayButton([IntPtr]$Hwnd, $CardRect, [string]$PlayLabel) {
  # ONE query pass. The card's hover overlay controls are SIBLINGS of the card, not part of its subtree:
  # the card subtree stays at 4 nodes (ListItem/Group/2 Text) even while the overlay is visible, so
  # containment of the button's BOX inside the card rectangle is the only usable predicate.
  $root = (Get-AmRoot $Hwnd).root
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'PlayButton')
  $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  for ($i = 0; $i -lt $els.Count; $i++) {
    $e = $els.Item($i)
    $z = $null
    try { $z = $e.Current.BoundingRectangle } catch { continue }
    if (-not (Test-AmRectSane $z)) { continue }
    if ($z.Left -lt $CardRect.Left -or $z.Left -gt ($CardRect.Left + $CardRect.Width)) { continue }
    if ($z.Top -lt $CardRect.Top -or $z.Top -gt ($CardRect.Top + $CardRect.Height)) { continue }
    if ($PlayLabel) { try { if (([string]$e.Current.Name).Trim() -ne $PlayLabel.Trim()) { continue } } catch { continue } }
    return @{ element = $e; name = [string]$e.Current.Name; rectKey = ('{0},{1},{2},{3}' -f [int]$z.Left, [int]$z.Top, [int]$z.Width, [int]$z.Height) }
  }
  return $null
}

function Find-AmCardHoverPlayButton([IntPtr]$Hwnd, $CardRect, [string]$PlayLabel, [int]$Attempts = 3, [int]$PollsPerAttempt = 8, [int]$PollMs = 150) {
  # MEASURED (2026-09-26, live app): hovering a search-result CARD reveals Button name="播放"
  # AutomationId=PlayButton at the card's bottom-left (rect 594,585,56,56 inside card 573,295,367,483)
  # plus Button name="更多" at the bottom-right. Clicking the PlayButton starts playback DIRECTLY
  # (SMTC Opened->Playing in 688ms) - no navigation step. The overlay IS a normal UIA element, unlike
  # the cover art, which is not exposed as an Image at all.
  # The overlay appears ONLY when the pointer MOVES while it is over the card. A pointer that merely
  # RESTS on the card - or on the cover - shows nothing (reported by the user, reproduced here); that is
  # why SetCursorPos to the position the cursor already occupies changes nothing. So every attempt
  # performs a two-point stroke across the card (the two points always differ) and then polls briefly.
  $cx = [int]($CardRect.Left + ($CardRect.Width / 2))
  $cy = [int]($CardRect.Top + ($CardRect.Height / 2))
  # Park OUTSIDE the card first, then approach in three moves. Measured 2026-09-26: a pointer that is
  # already inside the card - or that only jitters WITHIN it - can leave the app without a new enter
  # event and the overlay never renders (24/24 inside-only samples produced zero overlays, and four
  # consecutive in-card strokes found nothing either). Park -> edge -> near-centre -> centre produced the
  # overlay on the first poll, so every attempt now leaves the card and re-enters it.
  $parkX = [int]($CardRect.Left + $CardRect.Width + 70)
  $parkY = [int]($CardRect.Top + 30)
  for ($a = 1; $a -le $Attempts; $a++) {
    [void][AmUiaNative]::SetCursorPos($parkX, $parkY)
    Start-Sleep -Milliseconds 260
    [void][AmUiaNative]::SetCursorPos(($cx - 140), ($cy - 120))
    Start-Sleep -Milliseconds 180
    [void][AmUiaNative]::SetCursorPos(($cx - 40), ($cy - 20))
    Start-Sleep -Milliseconds 180
    [void][AmUiaNative]::SetCursorPos($cx, $cy)
    for ($q = 1; $q -le $PollsPerAttempt; $q++) {
      Start-Sleep -Milliseconds $PollMs
      $hit = Find-AmInCardPlayButton $Hwnd $CardRect $PlayLabel
      if ($hit) { return @{ ok = $true; element = $hit.element; attempts = $a; polls = $q; rectKey = $hit.rectKey } }
    }
  }
  return @{ ok = $false; element = $null; attempts = $Attempts; polls = 0; rectKey = '' }
}

function Wait-AmPlaylistTransition($Before, [int]$TimeoutMs, [int]$PollMs = 120) {
  # SMTC is the only judge (CONTROL-PLANE I1). A playlist has NO expected track title, so
  # Wait-AmPlayback(Title,Artist) cannot be used without inventing one. The observable is a
  # TRANSITION: status Playing AND (it was not Playing before OR the title changed).
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $state = $Before; $transition = $false
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    $state = Get-AmSmtcState
    if ($state.ok -and $state.status -eq 'Playing') {
      if ($Before.status -ne 'Playing' -or $state.title -ne $Before.title) { $transition = $true }
      break
    }
    Start-Sleep -Milliseconds $PollMs
  }
  return @{ transition = $transition; state = $state; ms = [int]$sw.ElapsedMilliseconds }
}

function Find-AmPlaylistPagePlayButton($root, [string]$PlayLabel, [switch]$AllowAlternateId) {
  # MEASURED (2026-09-26, live app): clicking a result CARD only NAVIGATES to the playlist page; playback
  # starts from the page header button AutomationId=PlayButton (clicked -> Paused->Playing in 275ms).
  # Matching is by AutomationId (locale-independent); $PlayLabel is only an extra guard when supplied.
  # A page opened by a DEEP LINK exposes a different id for the same Chinese label 播放: an album/song
  # page reached from a URL had AutomationId=PlayButtonElement (measured; the /cn/ link was ignored, the
  # /us/ link opened Dawn FM). That alternate id is only accepted when the caller opts in, so the verified
  # name route's behaviour is unchanged.
  $ids = @('PlayButton')
  if ($AllowAlternateId) { $ids += 'PlayButtonElement' }
  $out = @()
  foreach ($aid in $ids) {
    try {
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $aid)
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      for ($i = 0; $i -lt $all.Count; $i++) {
        $e = $all.Item($i)
        $isButton = $false
        try { $isButton = (([string]$e.Current.ControlType.ProgrammaticName) -match 'Button') } catch { }
        if (-not $isButton) { continue }
        $r = $null
        try { $r = $e.Current.BoundingRectangle } catch { continue }
        if (-not (Test-AmRectSane $r)) { continue }
        if ($PlayLabel) { try { if (([string]$e.Current.Name).Trim() -ne $PlayLabel.Trim()) { continue } } catch { continue } }
        $out += [pscustomobject]@{ element = $e; name = [string]$e.Current.Name; automationId = $aid }
      }
    } catch { }
    if ($out.Count -gt 0) { break }
  }
  return $out
}

function Wait-AmResultStability($Hwnd, [string]$Name, [int]$BudgetMs = 6000, [int]$SampleMs = 400, [int]$MaxSamples = 16) {
  # Bounded replacement for an unconditional fixed sleep. Apple Music renders search results in waves,
  # so scanning a half-built tree is both slow and wrong. Stability = two consecutive samples agreeing
  # on BOTH the deduped candidate count AND the raw descendant-node count: a single counter can look
  # stable (e.g. still 0) while the tree is still growing, and the candidate count alone can stay flat
  # while the result list keeps changing underneath. Both bounds (samples and wall clock) are explicit,
  # so the poll can never loop forever.
  #
  #   ready=$true  candidates=1   -> one candidate settled; safe to scan.
  #   ready=$true  candidates>=2  -> two distinct candidates already seen; the ambiguity contract
  #                                  applies immediately, no need to wait for the rest to load.
  #   ready=$false                -> budget exhausted while the tree never settled. Callers must NOT
  #                                  treat this as 'not found'; it gets its own stage.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $prevCand = -1; $prevNodes = -1; $stable = 0; $samples = 0; $cand = 0; $nodes = 0
  while ($samples -lt $MaxSamples -and $sw.ElapsedMilliseconds -lt $BudgetMs) {
    Start-Sleep -Milliseconds $SampleMs
    $samples++
    $root = (Get-AmRoot $Hwnd).root
    if (-not $root) { continue }
    $candRes = Get-AmPlaylistCardCandidates $root $Name -EarlyExitOnAmbiguous
    $cand = @($candRes.candidates).Count
    try { $nodes = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)).Count } catch { $nodes = -1 }
    if ($cand -ge 2) {
      return @{ ready = $true; reason = 'ambiguous_seen'; samples = $samples; candidates = $cand; nodes = $nodes; ms = [int]$sw.ElapsedMilliseconds; candidateCount = $cand }
    }
    if ($prevCand -eq $cand -and $prevNodes -eq $nodes) { $stable++ } else { $stable = 0 }
    $prevCand = $cand; $prevNodes = $nodes
    if ($stable -ge 1) {
      return @{ ready = $true; reason = 'settled'; samples = $samples; candidates = $cand; nodes = $nodes; ms = [int]$sw.ElapsedMilliseconds; candidateCount = $cand }
    }
  }
  return @{ ready = $false; reason = 'wait_budget'; samples = $samples; candidates = $cand; nodes = $nodes; ms = [int]$sw.ElapsedMilliseconds; candidateCount = $cand }
}

function Invoke-AmPlayPlaylist {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ScopeLabel = '',
    [string]$Url = '',   # a playlist (or song) link: navigation replaces search entirely when present
    [int]$SearchWaitMs = 6000,
    [switch]$Commit,
    [switch]$HoverProbe,   # read-only: hover the card and dump its subtree, never clicks
    [string]$PlayLabel = '',   # localized play-button label, supplied by the caller (keeps this file ASCII-only)
    [int]$CardIndex = 0,   # option 4: which matching card to pick (1-based); 0 = refuse when ambiguous
    [int]$SmtcTimeoutMs = 8000,   # how long to watch SMTC for the post-click Playing transition
    [switch]$TryHoverPlay,   # opt-in: actively hover the card to reveal its play button (measured unreliable in-engine; see the commit branch)
    [switch]$NoMinimize,   # keep Apple Music in front (default: minimize right after a successful play click, like the song chain)
    [switch]$DumpItems,
    [switch]$NoLaunch,
    [switch]$NoForeground,
    [string]$ShotPath = ''
  )
  $result = @{
    ok = $false; stage = 'UNKNOWN'; stageDetail = ''; stageHistory = @()
    name = $Name; scopeLabel = $ScopeLabel; mode = $(if ($Commit) { 'commit' } else { 'probe' }); scopeVerified = $false; scopeSwitchAttempts = 0
    candidateCount = 0; ambiguous = $false; clicked = $false; cards = @()
    playVia = ''; playButtonFound = $false; playButtonClicked = $false
    hoverPlayButton = $false; hoverAttempts = 0; hoverPolls = 0; minimizedAfterClick = $false
    smtc = @{ title = ''; artist = ''; status = ''; beforeTitle = ''; beforeArtist = ''; beforeStatus = ''; posMs = 0; hasSession = $false; transitionMs = 0 }
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

  # ---- URL route: when the caller HAS a link, navigation replaces the whole "search by name -> switch
  # to the library scope -> locate the card" dance. Deterministic: no name collision, no scope chip, no
  # ambiguity. Uses the frozen navigation helper the song chain verified (G3/G4): AppleMusic.exe /url.
  if ($stage -eq 'UNKNOWN' -and $Url) {
    $nav = Invoke-AmNavigateUrl $Url
    $result.url = $Url
    $result.navigatedBy = $nav.method
    # NOTE (measured): a link whose storefront does not match the account is accepted by the app but the"
    # page does not change - /cn/song/... left the UI untouched while /us/song/... opened the album page.
    if (-not $nav.ok) { $stage = 'URL_NAVIGATION_FAILED'; $detail = 'method=' + $nav.method }
  }

  if ($stage -eq 'UNKNOWN' -and -not $Url) {
    $root = $rootRes.root
    $sr = Invoke-AmSearch $root $Name $app.hwnd $SearchWaitMs
    $result.searchSubmitted = [bool]$sr.submitted
    if (-not $sr.ok) { $stage = 'SEARCH_FAILED'; $detail = [string]$sr.detail }
    else {
      if ($ScopeLabel) {
        # The scope chips are TogglePattern buttons that render together with the search UI, and a click
        # fired too early is simply SWALLOWED. MEASURED 2026-09-26: the chip was found and clicked while the
        # page was still rendering, the results stayed in the Apple Music scope, and the run ended as a
        # false PLAYLIST_NOT_FOUND (3/3). The old double click hid this - its second click did the work.
        # So: wait for the chip, click it ONCE, then VERIFY BY OUTCOME (does the library-scoped result
        # contain our card?) and click again only if it does not. Three attempts, odd on purpose: even if
        # the chip toggled instead of latching, the final state is the library scope.
        for ($att = 1; $att -le 3; $att++) {
          $chip = Find-AmScopeChip (Get-AmRoot $app.hwnd).root $ScopeLabel
          for ($cs = 1; $cs -le 6 -and -not $chip; $cs++) {
            Start-Sleep -Milliseconds 300
            $chip = Find-AmScopeChip (Get-AmRoot $app.hwnd).root $ScopeLabel
          }
          if (-not $chip) { $stage = 'SCOPE_CHIP_NOT_FOUND'; $detail = 'label=' + $ScopeLabel + ' after ' + (($cs - 1) * 300) + 'ms'; break }
          try {
            # 按状态切换，而不是盲点：chip 是 TogglePattern 开关，盲点会把已开启的范围点回全局。
            $scopeClick = Invoke-AmScopeChipSelect $chip
            $result.scopeChipClicked = [bool]$scopeClick.clicked
            $result.scopeChipReason = [string]$scopeClick.reason
            $result.scopeChipStateBefore = [string]$scopeClick.stateBefore
            $result.scopeChipStateAfter = [string]$scopeClick.stateAfter
            if (-not $result.scopeStateHistory) { $result.scopeStateHistory = @() }
            $result.scopeStateHistory += ($scopeClick.stateBefore + '->' + $scopeClick.stateAfter)
            # Bounded stability poll instead of a blind 1200ms sleep: after a scope toggle the list is
            # a different, still-rendering tree, and scanning it early is the stall.
            $st0 = Wait-AmResultStability $app.hwnd $Name $SearchWaitMs
            $result.scopeStability = @{ ready = $st0.ready; reason = $st0.reason; samples = $st0.samples; candidates = $st0.candidates; nodes = $st0.nodes; ms = $st0.ms }
            $result.scopeSwitched = $true
            $result.scopeSwitchAttempts = $att
          } catch { $stage = 'SCOPE_SWITCH_FAILED'; $detail = $_.Exception.Message; break }
          # 判据一（强）：chip 自身状态为 On。
          if ($result.scopeChipStateAfter -eq 'On') { $result.scopeVerified = $true; break }
          # 判据二（兜底）：状态读不到时，用「资料库范围内能找到目标卡片」作为结果验证。
          $scopeProbe = Get-AmPlaylistCardCandidates (Get-AmRoot $app.hwnd).root $Name -EarlyExitOnAmbiguous
          if (-not $result.scopeChipStateAfter -and @($scopeProbe.candidates).Count -gt 0) { $result.scopeVerified = $true; break }
        }
      }
      # HARD GATE (user-mandated): 音乐库内的搜索必须在『你的资料库』范围内完成。
      # 范围切换未通过结果验证时，绝不允许继续去主范围（Apple Music 目录）里搜 —— 那会把目录里
      # 同名的条目当成资料库条目选中。宁可失败并报出原因，也不静默降级。
      # 用独立 stage 中止：后面的主扫描因为 stage 不再是 UNKNOWN 会自然跳过。
      if (-not $result.scopeVerified) {
        $stage = 'SCOPE_NOT_VERIFIED'
        $detail = 'label=' + $ScopeLabel + ' attempts=' + $result.scopeSwitchAttempts + '：未能在资料库范围内确认目标，已中止（不回落到目录范围搜索）'
      }
    }
  }

  if ($stage -eq 'UNKNOWN' -and -not $Url) {
    $rootFresh = (Get-AmRoot $app.hwnd).root
    # $items was never assigned, so -DumpItems dumped nothing and the PLAYLIST_NOT_FOUND detail always
    # reported listItems=0 - a diagnostic that lied. am-play.ps1 fills the same variable the same way.
    # Bounded stability poll before scanning: results render in waves, so scanning a half-built tree is
    # both slow and wrong. Returns as soon as TWO distinct candidates exist (ambiguity applies at once)
    # or after two agreeing samples.
    $st = Wait-AmResultStability $app.hwnd $Name $SearchWaitMs
    $result.resultStability = @{ ready = $st.ready; reason = $st.reason; samples = $st.samples; candidates = $st.candidates; nodes = $st.nodes; ms = $st.ms }
    if (-not $st.ready) {
      # An unsettled tree is NOT 'not found': it gets its own stage so the caller can retry instead of
      # being told the album does not exist.
      $stage = 'RESULT_NOT_STABLE'
      $detail = 'result tree did not settle within ' + $SearchWaitMs + 'ms (samples=' + $st.samples + ' candidates=' + $st.candidates + ' nodes=' + $st.nodes + ')'
      $cards = @(); $items = @()
    }
    if ($stage -eq 'UNKNOWN') {
    $items = @(Get-AmListItems $rootFresh)
    $candRes = Get-AmPlaylistCardCandidates $rootFresh $Name -EarlyExitOnAmbiguous:($CardIndex -le 0)
    $result.scanEarlyExit = [bool]$candRes.earlyExit; $result.scanEarlyExitAt = [int]$candRes.earlyExitAt
    $cards = @($candRes.candidates)
    $result.dumpErrors = @($candRes.errors)

    $result.candidateCount = $cards.Count
    $result.cards = @($cards | ForEach-Object { @{ name = $_.name; rect = $_.rectKey; selfRect = $_.selfRect; selfType = $_.selfType; ancestors = @($_.ancestors) } })
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
    # option 4: the caller supplies the position; nothing is guessed here. It only SELECTS - whether that
    }
    # selection is allowed to click is decided below, after the PROBE check.
    $indexPicks = ($CardIndex -ge 1 -and $CardIndex -le $cards.Count)
    if ($cards.Count -eq 0) { $stage = 'PLAYLIST_NOT_FOUND'; $detail = 'listItems=' + @($items).Count }
    elseif ($cards.Count -gt 1 -and -not $indexPicks) { $stage = 'AMBIGUOUS'; $result.ambiguous = $true; $detail = 'cards=' + $cards.Count }
    elseif ($HoverProbe) {
      # read-only: the play button only materializes on hover, so move the cursor onto the card first and
      # then dump what the subtree exposes. Nothing is clicked in this mode.
      $c0 = $cards[0]
      $rectKey0 = $c0.rectKey
      $r0 = $c0.element.Current.BoundingRectangle
      # Move-AmCursor is defined nowhere in this repo (grep over experiment/) - it was a bare
      # CommandNotFoundException. Use the verified idiom from the frozen am-uia.ps1
      # (Invoke-AmRowPlay): AmUiaNative.SetCursorPos in physical pixels, DPI awareness already declared.
      [void][AmUiaNative]::SetCursorPos([int]($r0.Left + ($r0.Width / 2)), [int]($r0.Top + ($r0.Height / 2)))
      Start-Sleep -Milliseconds 700
      # Hovering repaints the page, so the element captured before the hover is stale: re-fetch the root and
      # re-locate the card before reading anything.
      $rootHover = (Get-AmRoot $app.hwnd).root
      $c0 = Refind-AmPlaylistCard $rootHover $Name $rectKey0
      $hover = @()
      try {
        if (-not $c0) {
          $result.dumpErrors = @($result.dumpErrors) + @('card stale after hover and could not be re-located')
        }
        $sub = @()
        if ($c0) { $sub = $c0.element.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition) }
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
    elseif (-not $Commit) {
      # PROBE contract: nothing in this branch clicks. -CardIndex ALONE must not click either (it used to,
      # which meant a "probe" could start playback just because the caller disambiguated by position).
      $stage = 'PROBE_ONLY'
      if ($indexPicks -and $cards.Count -gt 1) { $detail = 'card #' + $CardIndex + ' of ' + $cards.Count + ' selected by -CardIndex; nothing clicked (pass -Commit to click)' }
      else { $detail = 'card found; nothing clicked (pass -Commit to click)' }
    }
    else {
      if ($indexPicks) { $c = $cards[$CardIndex - 1]; $result.pickedByIndex = $true; $result.pickedIndex = $CardIndex }
      else { $c = $cards[0] }
      # Two measured paths, in order: (1) the card's OWN hover play button - starts playback directly;
      # (2) fall back to clicking the card (which only NAVIGATES) and then the playlist page's PlayButton.
      # Elements come from an earlier root and hovering repaints the page, so re-locate the card first.
      $rectKeyClick = $c.rectKey
      $rootClick = (Get-AmRoot $app.hwnd).root
      $cRefound = Refind-AmPlaylistCard $rootClick $Name $rectKeyClick
      if ($cRefound) { $c = $cRefound } else { $result.dumpErrors = @($result.dumpErrors) + @('card could not be re-located before the click; using the original reference') }

      $smtcBefore = Get-AmSmtcState
      $after = $smtcBefore; $transition = $false; $why = ''; $smtcMs = 0; $acted = $false

      # ---- fast path: an in-card PlayButton ALREADY in the tree (typically because the user is hovering
      # the card with a real mouse). One free query, no synthetic hovering, ~50ms. ----
      $hoverRect = $null
      try { $hoverRect = $c.element.Current.BoundingRectangle } catch { }
      $hover = @{ ok = $false; element = $null; attempts = 0; polls = 0; rectKey = '' }
      if ($hoverRect) {
        $hit = Find-AmInCardPlayButton $app.hwnd $hoverRect $PlayLabel
        if ($hit) { $hover = @{ ok = $true; element = $hit.element; attempts = 0; polls = 0; rectKey = $hit.rectKey } }
        elseif ($TryHoverPlay) {
          # OPT-IN active hover. MEASURED 2026-09-26: inside the engine flow this failed 6/6 even after the
          # park-outside + 3-step approach (an inside-only trace produced 24/24 samples with no overlay at
          # all), while the navigation path below succeeded 7/7. So it is NOT the default; it is kept for
          # hosts/versions where the overlay does render, and for further measurement.
          $hover = Find-AmCardHoverPlayButton $app.hwnd $hoverRect $PlayLabel
        }
      }
      if ($hover.ok) {
        $result.hoverPlayButton = $true; $result.hoverAttempts = $hover.attempts; $result.hoverPolls = $hover.polls
        $ptH = Get-AmSafeClickPoint $hover.element.Current.BoundingRectangle
        $hk = Invoke-AmSingleClick $app.hwnd $hover.element $ptH.x $ptH.y -NoForeground:$NoForeground
        if ($hk.ok) {
          $result.clicked = $true; $result.playVia = 'card-hover-play-button'; $acted = $true
          $result.minimizedAfterClick = Hide-AmAfterClick $app.hwnd -NoMinimize:$NoMinimize
          $w1 = Wait-AmPlaylistTransition $smtcBefore $SmtcTimeoutMs
          $after = $w1.state; $transition = $w1.transition; $smtcMs = $w1.ms
        } else { $why = 'card overlay PlayButton click failed: ' + [string]$hk.detail }
      }

      # ---- path 2 (fallback only): card click navigates, then the page header PlayButton plays ----
      if (-not $acted -and -not $why) {
        $pt1 = Get-AmSafeClickPoint $c.element.Current.BoundingRectangle
        $ck = Invoke-AmSingleClick $app.hwnd $c.element $pt1.x $pt1.y -NoForeground:$NoForeground
        if (-not $ck.ok) { $why = 'card click failed: ' + [string]$ck.detail }
        else {
          $result.clicked = $true; $result.playVia = 'card-click'; $acted = $true
          # some views may start playback on the card click itself - give SMTC a short window first
          $w0 = Wait-AmPlaylistTransition $smtcBefore 1500
          if ($w0.transition) { $after = $w0.state; $transition = $true; $smtcMs = $w0.ms }
          else {
            $pb = $null
            for ($t = 0; $t -lt 10 -and -not $pb; $t++) {
              Start-Sleep -Milliseconds 300
              $rootPage = (Get-AmRoot $app.hwnd).root
              $pbList = @(Find-AmPlaylistPagePlayButton $rootPage $PlayLabel)
              if ($pbList.Count -gt 0) { $pb = $pbList[0] }
            }
            if (-not $pb) { $why = 'card clicked, but the playlist page exposed no PlayButton within 3000ms' }
            else {
              $result.playButtonFound = $true
              # Same stale-element discipline as for the card: re-read from a freshly queried element.
              $rootPage2 = (Get-AmRoot $app.hwnd).root
              $pbList2 = @(Find-AmPlaylistPagePlayButton $rootPage2 $PlayLabel)
              if ($pbList2.Count -gt 0) { $pb = $pbList2[0] }
              $pt2 = Get-AmSafeClickPoint $pb.element.Current.BoundingRectangle
              $pk = Invoke-AmSingleClick $app.hwnd $pb.element $pt2.x $pt2.y -NoForeground:$NoForeground
              if (-not $pk.ok) { $why = 'page PlayButton click failed: ' + [string]$pk.detail }
              else {
                $result.playButtonClicked = $true; $result.playVia = 'page-play-button'
                $result.minimizedAfterClick = Hide-AmAfterClick $app.hwnd -NoMinimize:$NoMinimize
                $w2 = Wait-AmPlaylistTransition $smtcBefore $SmtcTimeoutMs
                $after = $w2.state; $transition = $w2.transition; $smtcMs = $w2.ms
              }
            }
          }
        }
      }

      $result.smtc = @{
        title = $after.title; artist = $after.artist; status = $after.status
        beforeTitle = $smtcBefore.title; beforeArtist = $smtcBefore.artist; beforeStatus = $smtcBefore.status
        posMs = $after.posMs; hasSession = [bool]$after.ok; transitionMs = $smtcMs
      }
      if ($transition) { $stage = 'PLAYBACK_STARTED'; $detail = 'SMTC ' + $smtcBefore.status + ' -> Playing via ' + $result.playVia + ' (' + $smtcMs + 'ms)' }
      elseif ($why) { $stage = 'PLAY_BUTTON_NOT_FOUND'; $detail = $why + ' (playback NOT started)' }
      elseif (-not $after.ok) { $stage = 'PLAYLIST_CLICKED'; $detail = 'clicked, but there is no SMTC session to verify against (playback NOT proven)' }
      elseif ($after.status -eq 'Playing') { $stage = 'PLAYBACK_UNCHANGED'; $detail = 'SMTC was already Playing and the title did not change; playlist playback NOT proven' }
      else { $stage = 'SMTC_TIMEOUT'; $detail = 'no Playing within ' + $SmtcTimeoutMs + 'ms after the click (status=' + $after.status + ')' }
    }
  }

  # ---- URL route, step 2: the page's own PlayButton, then the same SMTC criterion. Deliberately a
  # separate block from the name route's fallback (duplicated on purpose: that path is verified and must
  # not be disturbed by an unverified feature).
  if ($stage -eq 'UNKNOWN' -and $Url -and -not $Commit) {
    # PROBE contract: a URL still means navigation only; nothing is clicked without -Commit.
    $stage = 'PROBE_ONLY'
    $detail = 'URL opened (navigatedBy=' + $result.navigatedBy + '); nothing clicked (pass -Commit to click the page PlayButton)'
  }

  if ($stage -eq 'UNKNOWN' -and $Url) {
    $smtcBefore = Get-AmSmtcState
    $pb = $null
    for ($t = 0; $t -lt 12 -and -not $pb; $t++) {
      Start-Sleep -Milliseconds 400
      $rootPage = (Get-AmRoot $app.hwnd).root
      $pbList = @(Find-AmPlaylistPagePlayButton $rootPage $PlayLabel -AllowAlternateId)
      if ($pbList.Count -gt 0) { $pb = $pbList[0] }
    }
    $after = $smtcBefore; $transition = $false; $smtcMs = 0
    if (-not $pb) { $stage = 'PLAY_BUTTON_NOT_FOUND'; $detail = 'no PlayButton on the page opened by the URL within 4800ms' }
    else {
      $result.playButtonFound = $true
      $pt2 = Get-AmSafeClickPoint $pb.element.Current.BoundingRectangle
      $pk = Invoke-AmSingleClick $app.hwnd $pb.element $pt2.x $pt2.y -NoForeground:$NoForeground
      if (-not $pk.ok) { $stage = 'PLAY_BUTTON_NOT_FOUND'; $detail = 'PlayButton click failed: ' + [string]$pk.detail }
      else {
        $result.clicked = $true; $result.playButtonClicked = $true
        $result.playVia = 'url-page-play-button'
        $result.minimizedAfterClick = Hide-AmAfterClick $app.hwnd -NoMinimize:$NoMinimize
        $w = Wait-AmPlaylistTransition $smtcBefore $SmtcTimeoutMs
        $after = $w.state; $transition = $w.transition; $smtcMs = $w.ms
        $result.smtc = @{
          title = $after.title; artist = $after.artist; status = $after.status
          beforeTitle = $smtcBefore.title; beforeArtist = $smtcBefore.artist; beforeStatus = $smtcBefore.status
          posMs = $after.posMs; hasSession = [bool]$after.ok; transitionMs = $smtcMs
        }
        if ($transition) { $stage = 'PLAYBACK_STARTED'; $detail = 'URL -> SMTC ' + $smtcBefore.status + ' -> Playing via url-page-play-button (' + $smtcMs + 'ms)' }
        elseif (-not $after.ok) { $stage = 'PLAYLIST_CLICKED'; $detail = 'clicked, but there is no SMTC session to verify against (playback NOT proven)' }
        elseif ($after.status -eq 'Playing') { $stage = 'PLAYBACK_UNCHANGED'; $detail = 'SMTC was already Playing and the title did not change; playback NOT proven' }
        else { $stage = 'SMTC_TIMEOUT'; $detail = 'no Playing within ' + $SmtcTimeoutMs + 'ms after the URL page PlayButton (status=' + $after.status + ')' }
      }
    }
  }

  $result.stage = $stage; $result.stageDetail = $detail
  # Success is SMTC's call, not the click's (CONTROL-PLANE invariant I1): only a proven Playing transition
  # counts. PLAY_BUTTON_NOT_FOUND / PLAYLIST_CLICKED / PLAYBACK_UNCHANGED / SMTC_TIMEOUT all mean
  # "clicked, not proven".
  $result.ok = ($stage -eq 'PLAYBACK_STARTED')
  if (-not $result.ok -and $ShotPath) { [void](Save-AmShot $ShotPath) }
  return $result
}
