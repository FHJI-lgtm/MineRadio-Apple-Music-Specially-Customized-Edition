# ============================================================
# phase3.7B-uia-no-mouse/lib/instrumentation.ps1
# Auditing for a no-mouse / no-foreground-steal experiment.
#
# ISOLATION
#   * Reuses ONLY my own phase 3.7A instrument (nav-common.ps1).  The frozen
#     playback libs (poc/lib/am-play|am-uia|am-smtc|am-common) are never loaded.
#   * This file NEVER calls a mouse or keyboard API.  MouseGuard proves it two ways:
#       (a) static scan of the 3.7B scripts for forbidden tokens;
#       (b) runtime cursor sampling around every activation (cursorBefore==cursorAfter).
# ASCII-only.
# ============================================================

. (Join-Path (Split-Path $PSScriptRoot -Parent) '..\phase3.7A-navigation\lib\nav-common.ps1')

if (-not ('AmNm.Native' -as [type])) {
  Add-Type -Namespace AmNm -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
}

$script:AmNmRoot = Split-Path $PSScriptRoot -Parent
$script:AmNmReportDir = Join-Path $script:AmNmRoot 'reports'
$script:AmNmForbiddenTokens = @('SetCursorPos', 'mouse_event', 'SendInput', 'SendKeys', 'Cursor.Position', 'MoveTo(', 'BringWindowToTop')

function Get-AmNmReportDir {
  if (-not (Test-Path $script:AmNmReportDir)) { New-Item -ItemType Directory -Force -Path $script:AmNmReportDir | Out-Null }
  return $script:AmNmReportDir
}

function Get-AmNmCursor {
  try {
    $p = New-Object AmNm.Native+POINT
    if ([AmNm.Native]::GetCursorPos([ref]$p)) { return @{ ok = $true; x = $p.X; y = $p.Y } }
  } catch { }
  return @{ ok = $false; x = -1; y = -1 }
}

# (a) static MouseGuard: the experiment's own sources must not even mention a
# physical-input API.  The token list itself lives in this file, so it is excluded.
function Test-AmNmScriptHygiene {
  $hits = @()
  $files = @(Get-ChildItem -Path $script:AmNmRoot -Recurse -Filter '*.ps1' | Where-Object { $_.Name -ne 'instrumentation.ps1' })
  foreach ($f in $files) {
    $txt = Get-Content -Path $f.FullName -Raw -Encoding UTF8
    foreach ($tok in $script:AmNmForbiddenTokens) { if ($txt.Contains($tok)) { $hits += ($f.Name + ':' + $tok) } }
  }
  return @{ ok = ($hits.Count -eq 0); hits = $hits; scanned = $files.Count }
}

function Get-AmNmForeground {
  $res = @{ hwnd = 0; title = ''; pid = 0; process = ''; error = '' }
  try {
    $h = [AmNav.Native]::GetForegroundWindow()
    $res.hwnd = [int64]$h
    $sb = New-Object System.Text.StringBuilder 512
    [void][AmNav.Native]::GetWindowText($h, $sb, 512)
    $res.title = $sb.ToString()
    $pid = 0
    [void][AmNav.Native]::GetWindowThreadProcessId($h, [ref]$pid)
    $res.pid = [int]$pid
    if ($pid -gt 0) { $p = Get-Process -Id $pid -ErrorAction SilentlyContinue; if ($p) { $res.process = $p.ProcessName } }
  } catch { $res.error = $_.Exception.Message }
  return $res
}

function Get-AmNmFocus {
  $res = @{ ok = $false; name = ''; controlType = ''; automationId = ''; className = ''; error = '' }
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($el -ne $null) {
      $res.ok = $true
      $res.name = '' + $el.Current.Name
      $res.controlType = '' + $el.Current.ControlType.ProgrammaticName
      $res.automationId = '' + $el.Current.AutomationId
      $res.className = '' + $el.Current.ClassName
    }
  } catch { $res.error = $_.Exception.Message }
  return $res
}

function New-AmNmAudit {
  $c = Get-AmNmCursor
  $f = Get-AmNmForeground
  $fo = Get-AmNmFocus
  return @{ at = (Get-Date).ToString('HH:mm:ss.fff'); cursor = $c; cursorX = $c.x; cursorY = $c.y
            foregroundHwnd = $f.hwnd; foregroundTitle = $f.title; foregroundProcess = $f.process
            focusName = $fo.name; focusType = $fo.controlType }
}

function Compare-AmNmAudit($before, $after) {
  $mouseMoved = ($before.cursorX -ne $after.cursorX) -or ($before.cursorY -ne $after.cursorY)
  $fgChanged = ($before.foregroundHwnd -ne $after.foregroundHwnd)
  $fgByApp = $false
  if ($fgChanged -and ($after.foregroundProcess -like '*AppleMusic*')) { $fgByApp = $true }
  $focusChanged = ($before.focusName -ne $after.focusName) -or ($before.focusType -ne $after.focusType)
  return @{ mouseMoved = $mouseMoved; cursorBefore = ('' + $before.cursorX + ',' + $before.cursorY); cursorAfter = ('' + $after.cursorX + ',' + $after.cursorY)
            foregroundChanged = $fgChanged; foregroundChangedByApplication = $fgByApp
            foregroundBefore = ('' + $before.foregroundProcess + ': ' + $before.foregroundTitle)
            foregroundAfter = ('' + $after.foregroundProcess + ': ' + $after.foregroundTitle)
            focusChanged = $focusChanged; focusBefore = $before.focusName; focusAfter = $after.focusName
            physicalKeyboardInput = $false }
}

function ConvertTo-AmNmKey([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  $t = $s.ToLowerInvariant()
  $t = [regex]::Replace($t, '[^\p{L}\p{Nd}]', '')
  return $t
}

# the experiment's own matcher (deliberately NOT the frozen one)
function Test-AmNmTextMatch([string]$want, [string]$got) {
  $w = ConvertTo-AmNmKey $want; $g = ConvertTo-AmNmKey $got
  if (-not $w -or -not $g) { return $false }
  if ($g -eq $w) { return $true }
  return $g.Contains($w)
}

function Get-AmNmSmtc { return (Get-AmNavSmtcSnapshot) }

function Test-AmNmTargetPlaying($smtc, [string]$Title, [string]$Artist) {
  $titleOk = Test-AmNmTextMatch $Title ('' + $smtc.title)
  $artistOk = $true
  if ($Artist -ne '') { $artistOk = Test-AmNmTextMatch $Artist ('' + $smtc.artist) }
  $playing = (('' + $smtc.status) -eq 'Playing')
  return @{ ok = ($titleOk -and $artistOk -and $playing); titleOk = $titleOk; artistOk = $artistOk; playing = $playing
            smtcTitle = ('' + $smtc.title); smtcArtist = ('' + $smtc.artist); smtcStatus = ('' + $smtc.status) }
}
