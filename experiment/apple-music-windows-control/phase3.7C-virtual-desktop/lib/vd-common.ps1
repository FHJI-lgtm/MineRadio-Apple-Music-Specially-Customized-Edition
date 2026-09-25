# ============================================================
# phase3.7C-virtual-desktop/lib/vd-common.ps1
# Virtual Desktop Observation layer for the A-uia isolation PoC.
#
# SCOPE / DISCIPLINE
#   * Observation only.  Never calls MoveWindowToDesktop, never creates or deletes a
#     virtual desktop, never touches the registry, never runs elevated.
#   * The documented Virtual Desktop API is used, and EVERYTHING about it happens
#     INSIDE C#: object creation by the documented CLSID, the interface cast, and both
#     calls.  PowerShell only receives plain bool/string results, so it never attempts
#     to cast a System.__ComObject into a ComImport interface (that cast is what failed
#     before and is the single thing this revision fixes).
#   * Where a value needs undocumented internals (the active desktop's own GUID) this
#     file records `unavailable` and derives an explicit PROXY instead of guessing.
#   * Reuses the 3.7B audit helpers; the frozen A-uia entry is invoked by the runner.
#   * ASCII-only.
# ============================================================

. (Join-Path (Split-Path $PSScriptRoot -Parent) '..\phase3.7B-uia-no-mouse\lib\instrumentation.ps1')

if (-not ('AmVd.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AmVd {

  // Documented interface (shobjidl_core.h): IID_IVirtualDesktopManager
  [ComImport, Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IVirtualDesktopManager {
    void IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out int onCurrentDesktop);
    void GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
    void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  public static class Native {

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);

    private static IVirtualDesktopManager _vdm = null;
    private static string _initError = "not-initialised";

    // create + QueryInterface + hold the interface reference, all in C#
    public static string VdInit() {
      if (_vdm != null) { return "ok"; }
      try {
        Type t = Type.GetTypeFromCLSID(new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"), true);
        object raw = Activator.CreateInstance(t);
        _vdm = (IVirtualDesktopManager)raw;   // the cast that PowerShell could not do
        _initError = "ok";
        return "ok";
      } catch (Exception ex) {
        _initError = ex.Message;
        _vdm = null;
        return "error: " + ex.Message;
      }
    }

    public static string VdInitError() { return _initError; }

    // returns "true" / "false" / "unavailable" - nothing else crosses the boundary
    public static string VdIsOnCurrentDesktop(IntPtr hWnd) {
      if (VdInit() != "ok") { return "unavailable"; }
      try {
        int onCurrent;
        _vdm.IsWindowOnCurrentVirtualDesktop(hWnd, out onCurrent);
        return (onCurrent != 0) ? "true" : "false";
      } catch { return "unavailable"; }
    }

    // returns the desktop GUID as a string, or "unavailable"
    public static string VdGetDesktopId(IntPtr hWnd) {
      if (VdInit() != "ok") { return "unavailable"; }
      try {
        Guid g;
        _vdm.GetWindowDesktopId(hWnd, out g);
        return g.ToString();
      } catch { return "unavailable"; }
    }
  }
}
'@
}

$script:AmVdManagerHr = 'not-initialised'

function Initialize-AmVd {
  $s = [AmVd.Native]::VdInit()
  $script:AmVdManagerHr = $s
  return ($s -eq 'ok')
}

function Get-AmVdIsOnCurrentDesktop([IntPtr]$Hwnd) {
  if (-not (Initialize-AmVd)) { return @{ ok = $false; value = $null; error = $script:AmVdManagerHr } }
  $v = [AmVd.Native]::VdIsOnCurrentDesktop($Hwnd)
  if ($v -eq 'unavailable') { return @{ ok = $false; value = $null; error = 'vd-api-call-unavailable' } }
  return @{ ok = $true; value = [bool]::Parse($v); error = '' }
}

function Get-AmVdWindowDesktopId([IntPtr]$Hwnd) {
  if (-not (Initialize-AmVd)) { return @{ ok = $false; value = ''; error = $script:AmVdManagerHr } }
  $v = [AmVd.Native]::VdGetDesktopId($Hwnd)
  if ($v -eq 'unavailable') { return @{ ok = $false; value = ''; error = 'vd-api-call-unavailable' } }
  return @{ ok = $true; value = $v; error = '' }
}

# Plain Win32 enumeration of Apple Music top-level windows.  Kept separate from UIA so
# "Win32 can see it" and "UIA can see it" stay two different answers.
# NOTE: a PowerShell scriptblock used as a native delegate runs in its own scope, so the
# collection MUST live in a container the callback mutates through a method call.
function Find-AmVdAppleMusicWindow {
  $res = @{ ok = $false; hwnd = 0; title = ''; pid = 0; visible = $false; iconic = $false; candidates = @(); error = '' }
  try {
    $pids = @(Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    if ($pids.Count -eq 0) { $res.error = 'no-applemusic-process'; return $res }
    $bag = New-Object System.Collections.ArrayList
    $cb = [AmVd.EnumWindowsProc]{
      param([IntPtr]$h, [IntPtr]$l)
      $wpid = 0
      [void][AmVd.Native]::GetWindowThreadProcessId($h, [ref]$wpid)
      if ($pids -contains [int]$wpid) {
        $len = [AmVd.Native]::GetWindowTextLengthW($h)
        $sb = New-Object System.Text.StringBuilder ([Math]::Max(8, $len + 2))
        [void][AmVd.Native]::GetWindowTextW($h, $sb, $sb.Capacity)
        [void]$bag.Add(@{ hwnd = [int64]$h; pid = [int]$wpid; title = $sb.ToString(); visible = [AmVd.Native]::IsWindowVisible($h); iconic = [AmVd.Native]::IsIconic($h) })
      }
      return $true
    }
    [void][AmVd.Native]::EnumWindows($cb, [IntPtr]::Zero)
    $res.candidates = @($bag.ToArray())
    if ($res.candidates.Count -gt 0) {
      $main = @($res.candidates | Where-Object { $_.visible -and $_.title -ne '' })
      if ($main.Count -eq 0) { $main = @($res.candidates) }
      $res.ok = $true; $res.hwnd = $main[0].hwnd; $res.title = $main[0].title; $res.pid = $main[0].pid
      $res.visible = $main[0].visible; $res.iconic = $main[0].iconic
    } else { $res.error = 'enumwindows-saw-no-applemusic-window' }
  } catch { $res.error = $_.Exception.Message }
  return $res
}

# one full observation record: desktop facts + UIA reachability + SMTC
function Get-AmVdObservation {
  $o = [ordered]@{ at = (Get-Date).ToString('HH:mm:ss.fff') }
  $o['vdApiAvailable'] = (Initialize-AmVd)
  $o['vdApiError'] = $script:AmVdManagerHr

  $win = Find-AmVdAppleMusicWindow
  $o['appleMusicWin32Found'] = $win.ok
  $o['appleMusicWin32FindError'] = $win.error
  $o['appleMusicWindowHandle'] = $win.hwnd
  $o['appleMusicWindowTitle'] = $win.title
  $o['appleMusicVisible'] = $win.visible
  $o['appleMusicIconic'] = $win.iconic
  $o['appleMusicWin32CandidateCount'] = @($win.candidates).Count
  $o['appleMusicProcessRunning'] = (@(Get-Process -Name AppleMusic -ErrorAction SilentlyContinue).Count -gt 0)

  if ($win.hwnd -ne 0) {
    $onCur = Get-AmVdIsOnCurrentDesktop ([IntPtr]$win.hwnd)
    $did = Get-AmVdWindowDesktopId ([IntPtr]$win.hwnd)
    $o['appleMusicIsOnCurrentDesktop'] = if ($onCur.ok) { $onCur.value } else { 'unavailable' }
    $o['appleMusicDesktopId'] = if ($did.ok) { $did.value } else { 'unavailable' }
    $o['desktopQueryError'] = ('' + $onCur.error + '|' + $did.error)
  } else {
    $o['appleMusicIsOnCurrentDesktop'] = 'unavailable'
    $o['appleMusicDesktopId'] = 'unavailable'
    $o['desktopQueryError'] = 'no-window'
  }

  # ACTIVE desktop: no documented getter exists for the active desktop's own GUID, so
  # derive an explicit PROXY (the foreground window is by definition on the active desktop).
  $fg = [AmNav.Native]::GetForegroundWindow()
  $fgPid = 0
  [void][AmNav.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $fgProc = ''
  if ($fgPid -gt 0) { $p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue; if ($p) { $fgProc = $p.ProcessName } }
  $sb2 = New-Object System.Text.StringBuilder 512
  [void][AmNav.Native]::GetWindowText($fg, $sb2, 512)
  $o['foregroundHwnd'] = [int64]$fg
  $o['foregroundProcess'] = $fgProc
  $o['foregroundTitle'] = $sb2.ToString()
  $fgDid = Get-AmVdWindowDesktopId $fg
  $o['activeDesktopIdProxy'] = if ($fgDid.ok) { $fgDid.value } else { 'unavailable' }
  $o['activeDesktopIdProxyNote'] = 'documented API has no active-desktop getter; proxy = desktop id of the foreground window'

  # UIA reachability - a DIFFERENT question from whether input injection works
  try {
    $el = Get-AmNavWindowElement
    if ($el -ne $null) {
      $o['uiaWindowFound'] = $true
      $o['uiaWindowName'] = '' + $el.Current.Name
      $o['uiaWindowClass'] = '' + $el.Current.ClassName
      $o['uiaWindowControlType'] = '' + $el.Current.ControlType.ProgrammaticName
      $o['uiaWindowEnabled'] = [bool]$el.Current.IsEnabled
      $o['uiaWindowOffscreen'] = [bool]$el.Current.IsOffscreen
      $r = $el.Current.BoundingRectangle
      $o['uiaWindowBounds'] = ('' + [int]$r.Left + ',' + [int]$r.Top + ',' + [int]$r.Right + ',' + [int]$r.Bottom)
    } else {
      $o['uiaWindowFound'] = $false
      $o['uiaWindowName'] = ''; $o['uiaWindowClass'] = ''; $o['uiaWindowControlType'] = ''
      $o['uiaWindowEnabled'] = $null; $o['uiaWindowOffscreen'] = $null; $o['uiaWindowBounds'] = ''
    }
  } catch {
    $o['uiaWindowFound'] = $false
    $o['uiaWindowError'] = $_.Exception.Message
  }

  $s = Get-AmNavSmtcSnapshot
  $o['smtcTitle'] = $s.title
  $o['smtcArtist'] = $s.artist
  $o['smtcStatus'] = $s.status
  return $o
}
