# ============================================================
# phase3.7E-benchmark/lib/bench-common.ps1     (rev 2)
# Sampling + environment for the foreground-occupancy benchmark.
#
# SANCTIONED state changes (the phase explicitly allows exactly these, and nothing else):
#   * restore the ORIGINAL foreground window after a run   (SetForegroundWindow)
#   * restore the ORIGINAL cursor position after a run     (SetCursorPos)
# Both are restore-only, used after the measured window, and are never part of the
# activation mechanism.  No AttachThreadInput / AllowSetForegroundWindow /
# LockSetForegroundWindow is used anywhere.  Everything else here is read-only.
#
# rev 2: the P/Invoke type now carries its own SetForegroundWindow (the previous version
# called [AmNav.Win], a type that only exists in the 3.7A experiment lib and was therefore
# never loaded here) and no longer declares a System.Drawing signature (which made the
# whole Add-Type fail, so [AmBench.Native] did not exist and cursor restore errored).
# ASCII-only.
# ============================================================

. (Join-Path (Split-Path $PSScriptRoot -Parent) '..\phase3.7C-virtual-desktop\lib\vd-common.ps1')

if (-not ('AmBench.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace AmBench {
  public static class Native {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder text, int count);
  }
}
'@
}

# fast, read-only sample used by the ~50ms observer
function Get-AmBenchSample {
  $am = Find-AmVdAppleMusicWindow
  $fg = [AmBench.Native]::GetForegroundWindow()
  $c = Get-AmNmCursor
  $s = Get-AmNavSmtcSnapshot
  return @{
    amFound = [bool]$am.ok
    amHwnd = [int64]$am.hwnd
    fgHwnd = [int64]$fg
    amIsForeground = (($am.hwnd -ne 0) -and ([int64]$fg -eq [int64]$am.hwnd))
    cursorX = $c.x
    cursorY = $c.y
    smtcTitle = ('' + $s.title)
    smtcStatus = ('' + $s.status)
  }
}

function Get-AmBenchEnv {
  $am = Find-AmVdAppleMusicWindow
  $fg = [AmBench.Native]::GetForegroundWindow()
  $fgPid = 0
  [void][AmVd.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $fgProc = ''
  if ($fgPid -gt 0) { $p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue; if ($p) { $fgProc = $p.ProcessName } }
  $fgDid = Get-AmVdWindowDesktopId $fg
  $onCur = @{ ok = $false; value = $null }
  $amDid = @{ ok = $false; value = '' }
  if ($am.hwnd -ne 0) { $onCur = Get-AmVdIsOnCurrentDesktop ([IntPtr]$am.hwnd); $amDid = Get-AmVdWindowDesktopId ([IntPtr]$am.hwnd) }
  $c = Get-AmNmCursor
  $build = ''
  try { $build = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop).CurrentBuildNumber } catch { }
  $amVer = ''
  try { $amPkg = Get-AppxPackage -Name 'AppleInc.AppleMusicWin' -ErrorAction Stop; $amVer = $amPkg.Version.ToString() } catch { }
  $mon = -1
  try { $mon = ([System.Windows.Forms.Screen]::AllScreens).Count } catch { $mon = -1 }
  return @{
    windowsBuild = $build
    appleMusicVersion = $amVer
    monitorCount = $mon
    originalForegroundHwnd = [int64]$fg
    originalForegroundProcess = $fgProc
    cursorX = $c.x
    cursorY = $c.y
    activeDesktopIdProxy = if ($fgDid.ok) { $fgDid.value } else { 'unavailable' }
    appleMusicHwnd = [int64]$am.hwnd
    appleMusicDesktopId = if ($amDid.ok) { $amDid.value } else { 'unavailable' }
    appleMusicIsOnCurrentDesktop = if ($onCur.ok) { $onCur.value } else { 'unavailable' }
  }
}

# restore-only helpers (sanctioned by the phase; used AFTER the measured window)
function Invoke-AmBenchRestoreForeground([int64]$Hwnd) {
  try {
    if ($Hwnd -eq 0) { return 'no-original-hwnd' }
    [void][AmBench.Native]::SetForegroundWindow([IntPtr]$Hwnd)
    Start-Sleep -Milliseconds 150
    $now = [AmBench.Native]::GetForegroundWindow()
    if ([int64]$now -eq $Hwnd) { return 'ok' }
    return ('not-restored: fg=' + [int64]$now + ' win32=' + [int][System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
  } catch { return ('error: ' + $_.Exception.Message) }
}

function Invoke-AmBenchRestoreCursor([int]$X, [int]$Y) {
  try {
    [void][AmBench.Native]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 60
    $c = Get-AmNmCursor
    if ($c.x -eq $X -and $c.y -eq $Y) { return 'ok' }
    return ('mismatch: ' + $c.x + ',' + $c.y)
  } catch { return ('error: ' + $_.Exception.Message) }
}
