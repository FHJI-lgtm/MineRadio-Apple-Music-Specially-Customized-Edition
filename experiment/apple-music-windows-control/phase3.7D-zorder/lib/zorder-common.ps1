# ============================================================
# phase3.7D-zorder/lib/zorder-common.ps1
# Z-order observation + the single controlled Z-order operation for Phase 3.7D.
#
# SCOPE / DISCIPLINE
#   * Observation, plus exactly ONE documented Win32 call:
#       SetWindowPos(hwnd, HWND_BOTTOM, 0,0,0,0, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_SHOWWINDOW)
#     Nothing else is changed: no window styles, no owner changes, no AttachThreadInput,
#     no SetThreadDesktop, no AllowSetForegroundWindow, no LockSetForegroundWindow,
#     no registry, no elevation, no virtual desktop calls at all (reused here ONLY for
#     read-only desktop facts that the required field list asks for).
#   * Z-order and foreground are treated as two DIFFERENT things and recorded separately.
#   * ASCII-only.
# ============================================================

. (Join-Path (Split-Path $PSScriptRoot -Parent) '..\phase3.7B-uia-no-mouse\lib\instrumentation.ps1')
. (Join-Path (Split-Path $PSScriptRoot -Parent) '..\phase3.7C-virtual-desktop\lib\vd-common.ps1')

if (-not ('AmZo.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AmZo {
  public static class Native {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  }
}
'@
}

# HWND_BOTTOM / SWP flags (documented constants)
$script:AmZoHwndBottom = [IntPtr]1
$script:AmZoSwpNoSize = [uint32]0x0001
$script:AmZoSwpNoMove = [uint32]0x0002
$script:AmZoSwpNoActivate = [uint32]0x0010
$script:AmZoSwpShowWindow = [uint32]0x0040

# --- Z-order observation (auxiliary evidence only; foreground stays the core variable)
function Get-AmZoOrder {
  $res = [ordered]@{ ok = $false; appleMusicIndex = -1; topLevelCount = 0; isTopWindow = $false
                     topWindowTitle = ''; aboveAppleMusic = @(); error = '' }
  try {
    $am = Find-AmVdAppleMusicWindow
    if (-not $am.ok) { $res.error = 'no-applemusic-window'; return $res }
    $amHwnd = [IntPtr]$am.hwnd
    $h = [AmZo.Native]::GetTopWindow([IntPtr]::Zero)
    $i = 0
    $above = @()
    while ($h -ne [IntPtr]::Zero -and $i -lt 2000) {
      if ($i -eq 0) {
        $sb0 = New-Object System.Text.StringBuilder 256
        [void][AmZo.Native]::GetWindowTextW($h, $sb0, 256)
        $res.topWindowTitle = $sb0.ToString()
      }
      if ([int64]$h -eq [int64]$amHwnd) {
        $res.appleMusicIndex = $i
        break
      }
      if ($i -lt 12) {
        $sb = New-Object System.Text.StringBuilder 256
        [void][AmZo.Native]::GetWindowTextW($h, $sb, 256)
        $t = $sb.ToString()
        if ($t -ne '') { $above += $t }
      }
      $h = [AmZo.Native]::GetWindow($h, 2)   # GW_HWNDNEXT
      $i++
    }
    $res.topLevelCount = $i
    $res.isTopWindow = ($res.appleMusicIndex -eq 0)
    $res.aboveAppleMusic = @($above)
    $res.ok = $true
  } catch { $res.error = $_.Exception.Message }
  return $res
}

# --- the ONE allowed state change: push Apple Music to the bottom WITHOUT activating it
function Invoke-AmZoPushToBottom {
  param([IntPtr]$Hwnd)
  $r = [ordered]@{ method = 'SetWindowPos'; hwnd = [int64]$Hwnd; hwndInsertAfter = 'HWND_BOTTOM (1)'
                   flags = 'SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_SHOWWINDOW'
                   flagsValue = ('0x' + ('{0:X}' -f ($script:AmZoSwpNoMove -bor $script:AmZoSwpNoSize -bor $script:AmZoSwpNoActivate -bor $script:AmZoSwpShowWindow)))
                   ok = $false; win32Error = 0; error = '' }
  try {
    $flags = $script:AmZoSwpNoMove -bor $script:AmZoSwpNoSize -bor $script:AmZoSwpNoActivate -bor $script:AmZoSwpShowWindow
    $ok = [AmZo.Native]::SetWindowPos($Hwnd, $script:AmZoHwndBottom, 0, 0, 0, 0, $flags)
    $r.ok = [bool]$ok
    $r.win32Error = [int][System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  } catch { $r.error = $_.Exception.Message }
  return $r
}

# --- one full observation record with the field names the phase mandates
function Get-AmZoObservation {
  $o = [ordered]@{ at = (Get-Date).ToString('HH:mm:ss.fff') }
  $am = Find-AmVdAppleMusicWindow
  $o['appleMusicProcessRunning'] = (@(Get-Process -Name AppleMusic -ErrorAction SilentlyContinue).Count -gt 0)
  $o['appleMusicWindowHandle'] = $am.hwnd
  $o['appleMusicWindowTitle'] = $am.title
  $o['appleMusicVisible'] = $am.visible
  $o['appleMusicIconic'] = $am.iconic
  $o['appleMusicWin32Found'] = $am.ok
  $o['appleMusicWin32FindError'] = $am.error
  $o['appleMusicWindowClass'] = ''
  if ($am.hwnd -ne 0) {
    try {
      $el = Get-AmNavWindowElement
      if ($el -ne $null) { $o['appleMusicWindowClass'] = '' + $el.Current.ClassName }
    } catch { }
  }

  if ($am.hwnd -ne 0) {
    $onCur = Get-AmVdIsOnCurrentDesktop ([IntPtr]$am.hwnd)
    $did = Get-AmVdWindowDesktopId ([IntPtr]$am.hwnd)
    $o['appleMusicIsOnCurrentDesktop'] = if ($onCur.ok) { $onCur.value } else { 'unavailable' }
    $o['appleMusicDesktopId'] = if ($did.ok) { $did.value } else { 'unavailable' }
  } else {
    $o['appleMusicIsOnCurrentDesktop'] = 'unavailable'
    $o['appleMusicDesktopId'] = 'unavailable'
  }

  # foreground + active-desktop proxy (documented API has no active-desktop getter)
  $fg = [AmZo.Native]::GetForegroundWindow()
  $fgPid = 0
  [void][AmZo.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $fgProc = ''
  if ($fgPid -gt 0) { $p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue; if ($p) { $fgProc = $p.ProcessName } }
  $sb = New-Object System.Text.StringBuilder 512
  [void][AmZo.Native]::GetWindowTextW($fg, $sb, 512)
  $o['foregroundWindow'] = [int64]$fg
  $o['foregroundTitle'] = $sb.ToString()
  $o['foregroundProcess'] = $fgProc
  $o['appleMusicIsForeground'] = (($am.hwnd -ne 0) -and ([int64]$fg -eq [int64]$am.hwnd))
  $fgDid = Get-AmVdWindowDesktopId $fg
  $o['activeDesktopIdProxy'] = if ($fgDid.ok) { $fgDid.value } else { 'unavailable' }

  $c = Get-AmNmCursor
  $o['mouseX'] = $c.x
  $o['mouseY'] = $c.y

  $zo = Get-AmZoOrder
  $o['zOrderObservation'] = ('index=' + $zo.appleMusicIndex + ' topLevelCount=' + $zo.topLevelCount + ' isTop=' + $zo.isTopWindow + ' topTitle=[' + $zo.topWindowTitle + ']')
  $o['zOrderIndex'] = $zo.appleMusicIndex
  $o['zOrderIsTop'] = $zo.isTopWindow

  try {
    $el2 = Get-AmNavWindowElement
    $o['uiaWindowFound'] = ($el2 -ne $null)
  } catch { $o['uiaWindowFound'] = $false }

  $s = Get-AmNavSmtcSnapshot
  $o['smtcTitle'] = $s.title
  $o['smtcArtist'] = $s.artist
  $o['smtcStatus'] = $s.status
  return $o
}
