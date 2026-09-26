# ============================================================
# poc/lib/am-uia.ps1
# UI Automation access to the Apple Music window:
#   ensure running / find window / open search / type query / pick candidate row
#   / realize virtualized row / safe click point / synthesized double click.
#
# Ported from the verified PoC scripts (same order of steps, same click point):
#   recon/10-uia-tree-and-search-poc.ps1  (search box discovery)
#   recon/13-latency-and-search.ps1       (search + per-stage timing)
#   recon/12-poc-uia-play-v2.ps1          (realize, safe point, double click, screenshot)
#
# Safety: official UI Automation + synthesized mouse input only. No injection,
# no memory access, no private interfaces.
# ASCII-only on purpose (non-ASCII data comes from songs.json as UTF-8).
# ============================================================

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

$amUiaSig = @'
using System;
using System.Runtime.InteropServices;
public static class AmUiaNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
try { Add-Type -TypeDefinition $amUiaSig -Language CSharp -ErrorAction Stop } catch { }

# UI Automation reports PHYSICAL pixels. Without DPI awareness SetCursorPos works
# in virtualized (DIP) coordinates and every synthesized click would land on the
# wrong spot on a scaled display, so declare awareness before any geometry work.
try { [void][AmUiaNative]::SetProcessDPIAware() } catch { }

# ------------------------------------------------------------
# 1. app lifecycle
# ------------------------------------------------------------
function Get-AmProcess {
  $p = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue
  if ($p) { $p.Refresh() }
  return $p
}

# Returns @{ ok; launched; pid; hwnd; ensureAppMs; stage }
# stage: OK | APP_NOT_RUNNING
function Ensure-AmRunning([int]$TimeoutMs = 30000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $launched = $false
  $p = Get-AmProcess
  if (-not $p) {
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\AppleMusic.exe'
    try {
      if (Test-Path $alias) { Start-Process -FilePath $alias | Out-Null }
      else { Start-Process 'shell:AppsFolder\AppleInc.AppleMusicWin_nzyj5cx40ttqa!App' | Out-Null }
      $launched = $true
    } catch {
      return @{ ok = $false; launched = $false; pid = 0; hwnd = [IntPtr]::Zero; ensureAppMs = [int]$sw.ElapsedMilliseconds; stage = 'APP_NOT_RUNNING' }
    }
  }
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    $p = Get-AmProcess
    if ($p -and $p.MainWindowHandle -ne 0) {
      return @{ ok = $true; launched = $launched; pid = $p.Id; hwnd = $p.MainWindowHandle; ensureAppMs = [int]$sw.ElapsedMilliseconds; stage = 'OK' }
    }
    Start-Sleep -Milliseconds 300
  }
  return @{ ok = $false; launched = $launched; pid = 0; hwnd = [IntPtr]::Zero; ensureAppMs = [int]$sw.ElapsedMilliseconds; stage = 'APP_NOT_RUNNING' }
}

# ------------------------------------------------------------
# ------------------------------------------------------------
# 2. window state / UIA root
# ------------------------------------------------------------
function Get-AmWindowState([IntPtr]$Hwnd) {
  $st = @{ iconic = $false; zoomed = $false; visible = $false; foreground = $false; rect = '' }
  try {
    $st.iconic = [AmUiaNative]::IsIconic($Hwnd)
    $st.zoomed = [AmUiaNative]::IsZoomed($Hwnd)
    $st.visible = [AmUiaNative]::IsWindowVisible($Hwnd)
    $st.foreground = ([AmUiaNative]::GetForegroundWindow() -eq $Hwnd)
    $r = New-Object AmUiaNative+RECT
    [void][AmUiaNative]::GetWindowRect($Hwnd, [ref]$r)
    $st.rect = ('' + $r.Left + ',' + $r.Top + ' ' + ($r.Right - $r.Left) + 'x' + ($r.Bottom - $r.Top))
  } catch { }
  return $st
}

# A minimized window reports an empty UIA root rectangle, so every row rect is
# empty too. Restore it (SW_RESTORE) before any UIA geometry work; this only
# acts when the window is actually minimized or hidden (no-op otherwise).
function Restore-AmWindow([IntPtr]$Hwnd, [int]$WaitMs = 600) {
  $before = Get-AmWindowState $Hwnd
  $restored = $false
  $reason = ''
  if ($before.iconic -or -not $before.visible) {
    [void][AmUiaNative]::ShowWindow($Hwnd, 9)   # SW_RESTORE
    $restored = $true
    $reason = 'minimized'
    Start-Sleep -Milliseconds $WaitMs
  } else {
    # A window that hangs outside the screen (observed after a display-scale change:
    # 1920x1103 at 308,308 on a 1920x1080 screen) reports row rectangles that fall
    # outside the virtual screen, so every click is rejected as BOUNDS_INVALID.
    # Maximizing puts the whole content back on screen.
    $rr = New-Object AmUiaNative+RECT
    [void][AmUiaNative]::GetWindowRect($Hwnd, [ref]$rr)
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($rr.Left -lt $vs.Left -or $rr.Top -lt $vs.Top -or $rr.Right -gt ($vs.Left + $vs.Width) -or $rr.Bottom -gt ($vs.Top + $vs.Height)) {
      [void][AmUiaNative]::ShowWindow($Hwnd, 3)   # SW_MAXIMIZE
      $restored = $true
      $reason = 'outside-screen'
      Start-Sleep -Milliseconds $WaitMs
    }
  }
  $after = Get-AmWindowState $Hwnd
  return @{ restored = $restored; reason = $reason; before = $before; after = $after }
}

# stage: OK | AM_UI_NOT_FOUND
function Get-AmRoot([IntPtr]$Hwnd, [int]$Retries = 6, [int]$DelayMs = 400) {
  for ($i = 0; $i -lt $Retries; $i++) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
      if ($root) { return @{ ok = $true; root = $root; stage = 'OK'; tries = ($i + 1) } }
    } catch { }
    Start-Sleep -Milliseconds $DelayMs
  }
  return @{ ok = $false; root = $null; stage = 'AM_UI_NOT_FOUND'; tries = $Retries }
}

function Find-AmSearchButton($root) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'Search_Button')
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Find-AmEnabledEdit($root) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
  $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  for ($i = 0; $i -lt $edits.Count; $i++) {
    $e = $edits.Item($i)
    if ($e.Current.IsEnabled) { return @{ element = $e; count = $edits.Count; index = $i } }
  }
  return @{ element = $null; count = $edits.Count; index = -1 }
}

# ------------------------------------------------------------
# 3. search
# ------------------------------------------------------------
# Opens the search box (if needed), types the query. Timing excludes nothing -
# callers measure around this call.
# stage: OK | SEARCH_FAILED
function Invoke-AmSearch($root, [string]$Query, [IntPtr]$Hwnd = [IntPtr]::Zero, [int]$TimeoutMs = 4000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $alreadyOpen = $false
  if ($Hwnd -ne [IntPtr]::Zero) {
    Invoke-AmForeground $Hwnd
    Start-Sleep -Milliseconds 250
  }
  $edit = (Find-AmEnabledEdit $root).element

  if (-not $edit) {
    $btn = Find-AmSearchButton $root
    if (-not $btn) {
      return @{ ok = $false; stage = 'SEARCH_FAILED'; ms = [int]$sw.ElapsedMilliseconds; detail = 'Search_Button not found'; alreadyOpen = $false }
    }
    try { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch { }
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
      Start-Sleep -Milliseconds 150
      $edit = (Find-AmEnabledEdit $root).element
      if ($edit) { break }
    }
  } else {
    $alreadyOpen = $true
  }

  if (-not $edit) {
    return @{ ok = $false; stage = 'SEARCH_FAILED'; ms = [int]$sw.ElapsedMilliseconds; detail = 'no enabled Edit control after opening search'; alreadyOpen = $false }
  }

  $submitted = $false
  try {
    $edit.SetFocus()
    Start-Sleep -Milliseconds 150
    $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    # Clear first so re-running the same query still triggers a fresh search:
    # ValuePattern.SetValue with an identical value raises no change event.
    try { $vp.SetValue(''); Start-Sleep -Milliseconds 120 } catch { }
    $vp.SetValue($Query)
    Start-Sleep -Milliseconds 150
    # ValuePattern.SetValue only fills the box; Apple Music needs a submit.
    # Enter is used instead of synthesized typing because CJK titles cannot be
    # typed reliably through SendKeys (they would need an IME).
    try { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); $submitted = $true } catch { }
  } catch {
    return @{ ok = $false; stage = 'SEARCH_FAILED'; ms = [int]$sw.ElapsedMilliseconds; detail = ('SetValue failed: ' + $_.Exception.Message); alreadyOpen = $alreadyOpen; submitted = $false }
  }
  return @{ ok = $true; stage = 'OK'; ms = [int]$sw.ElapsedMilliseconds; detail = ''; alreadyOpen = $alreadyOpen; submitted = $submitted }
}

# A cheap fingerprint of the current page/list content, used to tell "the URL did
# not navigate anywhere" (URL_NAVIGATION_FAILED) apart from "the page opened but
# the wanted row is not there" (TARGET_ROW_NOT_FOUND).
function Get-AmTreeSignature($root) {
  $items = Get-AmListItems $root
  $names = @()
  $n = 0
  foreach ($it in $items) {
    $n++
    if ($n -gt 12) { break }
    $names += (Truncate-AmText $it.name 24)
  }
  return ('' + $items.Count + '|' + ($names -join ';'))
}

# Navigation only - it never counts as success. Uses the previously verified form
# `AppleMusic.exe /url "<URL>"` (execution alias of the Store package) and falls
# back to the shell handler if the alias is unavailable.
function Invoke-AmNavigateUrl([string]$Url) {
  $method = ''
  $exe = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\AppleMusic.exe'
  if (Test-Path $exe) {
    try {
      Start-Process -FilePath $exe -ArgumentList ('/url "' + $Url + '"') | Out-Null
      $method = 'AppleMusic.exe /url'
    } catch { $method = '' }
  }
  if (-not $method) {
    try { Start-Process $Url | Out-Null; $method = 'shell-open' } catch { $method = 'failed' }
  }
  Start-Sleep -Milliseconds 500
  return @{ method = $method; ok = ($method -ne 'failed') }
}

function Get-AmListItems($root) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $out = @()
  for ($i = 0; $i -lt $items.Count; $i++) { $out += , @{ index = $i; element = $items.Item($i); name = ('' + $items.Item($i).Current.Name) } }
  return $out
}

# ------------------------------------------------------------
# 4. candidate selection
# ------------------------------------------------------------
# Title is the primary key; artist only narrows duplicates.
#   ambiguous          : more than one row matched the title
#   candidates         : ALL title-matching rows, ranked best-first
#   ambiguous          : more than one row matched the title
#   pickedByPosition   : the top rank is shared by several rows (artist did not
#                        single one out), so the outcome relies on document order
# stage: OK | RESULT_NOT_FOUND
#
# Ranking (Apple Music search results contain non-song rows that echo the query,
# e.g. a lowercase "top result"/group row, so the title alone is not enough):
#   artist hit (when an artist was given)  -> +100   primary, narrows duplicates
#   title score (3 exact / 2 prefix / 1 anywhere) -> x10
#   row exposes SelectionItemPattern       -> +2     it is a selectable list row
#   row exposes InvokePattern              -> +1     it is activatable
function Get-AmRowSignals($element) {
  $hasSelection = $false; $hasInvoke = $false
  try {
    foreach ($p in $element.GetSupportedPatterns()) {
      $n = '' + $p.ProgrammaticName
      if ($n -match 'SelectionItemPattern') { $hasSelection = $true }
      if ($n -match 'InvokePattern') { $hasInvoke = $true }
    }
  } catch { }
  return @{ selectionItem = $hasSelection; invoke = $hasInvoke }
}

function Select-AmCandidate($items, [string]$Title, [string]$Artist) {
  $cands = @()
  $seenRuntime = @{}
  foreach ($it in $items) {
    $score = Get-AmTitleScore $it.name $Title
    if ($score -lt 1) { continue }
    # Apple Music's search tree can expose the same row more than once
    # (duplicate automation elements): keep the first occurrence only.
    $rid = ''
    try { $rid = ('' + ($it.element.GetRuntimeId() -join '-')) } catch { $rid = '' }
    if ($rid) {
      if ($seenRuntime.ContainsKey($rid)) { continue }
      $seenRuntime[$rid] = $true
    }
    $artistHit = $false
    if ($Artist) { $artistHit = Test-AmArtistInName $it.name $Artist }
    $sig = Get-AmRowSignals $it.element
    $rank = ($score * 10)
    if ($Artist -and $artistHit) { $rank += 100 }
    if ($sig.selectionItem) { $rank += 2 }
    if ($sig.invoke) { $rank += 1 }
    $cands += , @{
      index = $it.index; element = $it.element; name = $it.name; titleScore = $score
      artistHit = $artistHit; rank = $rank; selectionItem = $sig.selectionItem; invoke = $sig.invoke
    }
  }
  if ($cands.Count -eq 0) {
    return @{ ok = $false; stage = 'RESULT_NOT_FOUND'; candidateCount = 0; ambiguous = $false; pickedByPosition = $false; artistFiltered = $false; candidates = @(); competitors = @() }
  }

  # NOTE: Sort-Object needs the scriptblock form here - with Hashtable input the
  # string form ('rank') resolves to nothing and silently keeps the input order.
  $sorted = @($cands | Sort-Object -Property @{ Expression = { $_.rank }; Descending = $true }, @{ Expression = { $_.index }; Ascending = $true })
  $maxRank = $sorted[0].rank
  $topCount = @($sorted | Where-Object { $_.rank -eq $maxRank }).Count
  $artistFiltered = $false
  if ($Artist) { $artistFiltered = (@($sorted | Where-Object { $_.artistHit }).Count -gt 0) }

  $competitors = @()
  for ($i = 1; $i -lt $sorted.Count; $i++) {
    if ($competitors.Count -ge 3) { break }
    $n = $sorted[$i].name
    if ($n.Length -gt 90) { $n = $n.Substring(0, 90) }
    $competitors += , $n
  }

  return @{
    ok = $true; stage = 'OK'
    candidateCount = $cands.Count; ambiguous = ($cands.Count -gt 1)
    pickedByPosition = ($topCount -gt 1); artistFiltered = $artistFiltered
    candidates = $sorted; competitors = $competitors
  }
}

# Same ranking, but only keep candidates that already expose a rectangle: used by
# the deep-link mode where acting on a not-yet-rendered row would be pointless.
function Select-AmCandidateWithGeometry($items, [string]$Title, [string]$Artist) {
  $pick = Select-AmCandidate $items $Title $Artist
  if (-not $pick.ok) { $pick['hadGeometry'] = $false; return $pick }
  $withGeom = @()
  foreach ($c in $pick.candidates) {
    $r = $null
    try { $r = $c.element.Current.BoundingRectangle } catch { $r = $null }
    if ($r -and -not $r.IsEmpty) { $c['rect'] = $r; $withGeom += , $c }
  }
  $pick['candidates'] = $withGeom
  $pick['hadGeometry'] = ($withGeom.Count -gt 0)
  return $pick
}

# ------------------------------------------------------------
# 5. realize virtualized row (and make sure it is really clickable)
# ------------------------------------------------------------
function Test-AmRectSane($r) {
  if (-not $r -or $r.IsEmpty) { return $false }
  if ($r.Width -lt 40 -or $r.Height -lt 10) { return $false }
  try {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $cx = $r.Left + $r.Width / 2
    $cy = $r.Top + $r.Height / 2
    if ($cx -lt $vs.Left -or $cx -gt ($vs.Left + $vs.Width)) { return $false }
    if ($cy -lt $vs.Top -or $cy -gt ($vs.Top + $vs.Height)) { return $false }
  } catch { }
  return $true
}

# Client area of the window in physical pixels (same space as UIA rects).
function Get-AmClientRectPhysical([IntPtr]$Hwnd) {
  $wr = New-Object AmUiaNative+RECT
  [void][AmUiaNative]::GetWindowRect($Hwnd, [ref]$wr)
  $cr = New-Object AmUiaNative+RECT
  $ok = [AmUiaNative]::GetClientRect($Hwnd, [ref]$cr)
  if (-not $ok) { return @{ left = $wr.Left; top = $wr.Top; right = $wr.Right; bottom = $wr.Bottom } }
  $origin = New-Object AmUiaNative+POINT
  $origin.x = 0; $origin.y = 0
  [void][AmUiaNative]::ClientToScreen($Hwnd, [ref]$origin)
  return @{ left = $origin.x; top = $origin.y; right = ($origin.x + ($cr.Right - $cr.Left)); bottom = ($origin.y + ($cr.Bottom - $cr.Top)) }
}

# A UIA element can report a valid rectangle while being scrolled outside the
# window or covered by an overlay - clicking it then hits something else.
# The click point MUST be inside the client area and most of the element too.
function Get-AmRectVisibility($rect, $clientRect) {
  $res = @{ ratio = 0.0; clickable = $false; clickX = 0; clickY = 0; side = 'none' }
  if (-not $rect -or $rect.IsEmpty) { return $res }
  $l = [Math]::Max($rect.Left, $clientRect.left)
  $r = [Math]::Min(($rect.Left + $rect.Width), $clientRect.right)
  $t = [Math]::Max($rect.Top, $clientRect.top)
  $b = [Math]::Min(($rect.Top + $rect.Height), $clientRect.bottom)
  if ($r -gt $l -and $b -gt $t) { $res.ratio = (($r - $l) * ($b - $t)) / ($rect.Width * $rect.Height) }
  $pt = Get-AmSafeClickPoint $rect
  $res.clickX = $pt.x; $res.clickY = $pt.y
  $res.clickable = ($pt.x -ge $clientRect.left -and $pt.x -le $clientRect.right -and $pt.y -ge $clientRect.top -and $pt.y -le $clientRect.bottom)
  if ($rect.Top -ge $clientRect.bottom) { $res.side = 'below' }
  elseif (($rect.Top + $rect.Height) -le $clientRect.top) { $res.side = 'above' }
  else { $res.side = 'inside' }
  return $res
}

# Wheel-scroll the results area so a row that sits outside the viewport comes in.
# Direction: -1 = scroll down (content moves up), +1 = scroll up.
function Scroll-AmView([IntPtr]$Hwnd, [int]$Direction, [int]$Notches = 3) {
  $cr = Get-AmClientRectPhysical $Hwnd
  $cx = [int](($cr.left + $cr.right) / 2)
  $cy = [int]($cr.top + ($cr.bottom - $cr.top) * 0.7)
  [void][AmUiaNative]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 120
  $data = 120 * $Notches * $Direction
  [AmUiaNative]::mouse_event(0x0800, 0, 0, $data, 0)   # MOUSEEVENTF_WHEEL
  Start-Sleep -Milliseconds 450
}

# Poll for a non-empty rectangle (no pattern calls at all).
function Wait-AmRect($element, [int]$TimeoutMs = 600, [int]$PollMs = 100) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    $r = $null
    try { $r = $element.Current.BoundingRectangle } catch { $r = $null }
    if ($r -and -not $r.IsEmpty) { return $r }
    Start-Sleep -Milliseconds $PollMs
  }
  return $null
}

# Get a usable, actually clickable rectangle for the row.
#
# Order matters: a row that is already rendered reports its geometry right away,
# and calling ScrollItemPattern.ScrollIntoView()/VirtualizedItemPattern.Realize()
# on it can RE-EMPTY the rectangle (observed on the album track list). So only
# escalate to those patterns when the plain read does not give a rectangle.
# stage: OK | REALIZE_FAILED | BOUNDS_INVALID | OUT_OF_VIEW
function Realize-AmRow($element, [int]$TimeoutMs = 2000, [int]$PollMs = 100, [IntPtr]$Hwnd = [IntPtr]::Zero, [int]$MaxScrollSteps = 6) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $steps = @{ scrollIntoView = $false; realize = $false; setFocus = $false; scrollSteps = 0; escalated = $false }
  $rect = $null

  if ($Hwnd -ne [IntPtr]::Zero) { $client = Get-AmClientRectPhysical $Hwnd } else { $client = $null }

  # --- stage 1: plain read, then escalate one pattern at a time ---
  $rect = Wait-AmRect $element 500 $PollMs
  if (-not $rect) {
    $steps.escalated = $true
    try { $element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView(); $steps.scrollIntoView = $true } catch { }
    $rect = Wait-AmRect $element 700 $PollMs
  }
  if (-not $rect) {
    $steps.escalated = $true
    try { $element.GetCurrentPattern([System.Windows.Automation.VirtualizedItemPattern]::Pattern).Realize(); $steps.realize = $true } catch { }
    $rect = Wait-AmRect $element 800 $PollMs
  }
  if (-not $rect) {
    $steps.escalated = $true
    try { $element.SetFocus(); $steps.setFocus = $true } catch { }
    $rect = Wait-AmRect $element 800 $PollMs
  }

  # --- stage 2: if it exists but sits outside the viewport, scroll it in ---
  if ($rect -and $client) {
    for ($step = 0; $step -le $MaxScrollSteps; $step++) {
      if (-not (Test-AmRectSane $rect)) { break }
      $vis = Get-AmRectVisibility $rect $client
      if ($vis.clickable -and $vis.ratio -ge 0.7) {
        return @{ ok = $true; stage = 'OK'; ms = [int]$sw.ElapsedMilliseconds; rect = $rect; steps = $steps; visibility = $vis }
      }
      if ($step -ge $MaxScrollSteps) {
        return @{ ok = $false; stage = 'OUT_OF_VIEW'; ms = [int]$sw.ElapsedMilliseconds; rect = $rect; steps = $steps; visibility = $vis }
      }
      $dir = -1
      if ($vis.side -eq 'above') { $dir = 1 }
      Scroll-AmView $Hwnd $dir 3
      $steps.scrollSteps = $step + 1
      Start-Sleep -Milliseconds 250
      $again = Wait-AmRect $element 600 $PollMs
      if ($again) { $rect = $again }
    }
  }

  $ms = [int]$sw.ElapsedMilliseconds
  if (-not $rect -or $rect.IsEmpty) {
    return @{ ok = $false; stage = 'REALIZE_FAILED'; ms = $ms; rect = $null; steps = $steps }
  }
  if (-not (Test-AmRectSane $rect)) {
    return @{ ok = $false; stage = 'BOUNDS_INVALID'; ms = $ms; rect = $rect; steps = $steps }
  }
  return @{ ok = $true; stage = 'OK'; ms = $ms; rect = $rect; steps = $steps }
}

# ------------------------------------------------------------
# 6. click (verified approach: left safe area + synthesized double click)
# ------------------------------------------------------------
function Get-AmSafeClickPoint($rect) {
  $x = [int]($rect.Left + [Math]::Min(300, $rect.Width * 0.30))
  $y = [int]($rect.Top + $rect.Height / 2)
  return @{ x = $x; y = $y }
}

function Invoke-AmForeground([IntPtr]$Hwnd) {
  # SW_RESTORE must ONLY be used when the window is minimized: on a maximized
  # window it un-maximizes (changing the geometry right before a click, which
  # makes a previously computed click point land somewhere else).
  if ([AmUiaNative]::IsIconic($Hwnd)) { [void][AmUiaNative]::ShowWindow($Hwnd, 9) }
  [void][AmUiaNative]::SetForegroundWindow($Hwnd)
}

# stage: OK | CLICK_FAILED
function Invoke-AmRowPlay([IntPtr]$Hwnd, $Element, [int]$X, [int]$Y, [switch]$NoForeground) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $usedX = $X; $usedY = $Y; $recomputed = $false
  try {
    if (-not $NoForeground) {
      Invoke-AmForeground $Hwnd
      # ---- W3 state substitution (G3 candidate; the ONLY frozen-chain change) --------------
      # Was: Start-Sleep -Milliseconds 350 - a fixed wait whose verified meaning is only
      # "probably foreground by now".  Now: wait for the observable state
      # GetForegroundWindow() == $Hwnd, capped at the SAME 350 ms, and FAIL SAFE on timeout:
      # no geometry read, no cursor move, no click.  S1 only - no layout condition is added.
      # $global:AmW3Last is a side channel for the benchmark harness; the frozen am-play.ps1
      # aggregation is deliberately NOT modified.
      $w3sw = [Diagnostics.Stopwatch]::StartNew()
      $w3polls = 0; $w3ok = $false
      while ($w3sw.ElapsedMilliseconds -lt 350) {
        $w3polls++
        if ([int64][AmUiaNative]::GetForegroundWindow() -eq [int64]$Hwnd) { $w3ok = $true; break }
        Start-Sleep -Milliseconds 10
      }
      $global:AmW3Last = @{
        waitMs = [int]$w3sw.ElapsedMilliseconds
        polls = $w3polls
        satisfied = $w3ok
        timeout = (-not $w3ok)
        targetIconicAtSatisfied = [bool][AmUiaNative]::IsIconic($Hwnd)
      }
      if (-not $w3ok) {
        return @{ ok = $false; stage = 'W3_FOREGROUND_TIMEOUT'; ms = [int]$sw.ElapsedMilliseconds
                  detail = ('foreground != ' + $Hwnd + ' within 350ms (foreground=' + [int64][AmUiaNative]::GetForegroundWindow() + ')')
                  x = $usedX; y = $usedY; recomputed = $false }
      }
      # ---- end W3 substitution -------------------------------------------------------------
    }
    # The window may have moved/resized while coming to the foreground: re-read
    # the row geometry and recompute the safe point instead of trusting the
    # coordinates that were measured before the foreground call.
    if ($Element) {
      try {
        $r2 = $Element.Current.BoundingRectangle
        if (Test-AmRectSane $r2) {
          $pt2 = Get-AmSafeClickPoint $r2
          if ($pt2.x -ne $X -or $pt2.y -ne $Y) { $recomputed = $true }
          $usedX = $pt2.x; $usedY = $pt2.y
        }
      } catch { }
    }
    [void][AmUiaNative]::SetCursorPos($usedX, $usedY)
    Start-Sleep -Milliseconds 200
    [AmUiaNative]::mouse_event(2, 0, 0, 0, 0); [AmUiaNative]::mouse_event(4, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 130
    [AmUiaNative]::mouse_event(2, 0, 0, 0, 0); [AmUiaNative]::mouse_event(4, 0, 0, 0, 0)
  } catch {
    return @{ ok = $false; stage = 'CLICK_FAILED'; ms = [int]$sw.ElapsedMilliseconds; detail = $_.Exception.Message; x = $usedX; y = $usedY; recomputed = $recomputed }
  }
  return @{ ok = $true; stage = 'OK'; ms = [int]$sw.ElapsedMilliseconds; detail = ''; x = $usedX; y = $usedY; recomputed = $recomputed }
}

# ------------------------------------------------------------
# 7. evidence
# ------------------------------------------------------------
function Save-AmShot([string]$Path) {
  try {
    $p = Get-AmProcess
    if (-not $p -or $p.MainWindowHandle -eq 0) { return $false }
    $r = New-Object AmUiaNative+RECT
    [void][AmUiaNative]::GetWindowRect($p.MainWindowHandle, [ref]$r)
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { return $false }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [AmUiaNative]::PrintWindow($p.MainWindowHandle, $hdc, 2)
    $g.ReleaseHdc($hdc)
    if (-not $ok) { $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h)) }
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return $true
  } catch { return $false }
}
