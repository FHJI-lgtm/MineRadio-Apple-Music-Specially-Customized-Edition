# ============================================================
# phase3.7E-benchmark/lib/w3probe.ps1
# G1 read-only probe for the W3 state-substitution design (Q1: object semantics).
#
# DISCIPLINE / SAFETY (G0 static review target)
#   * Observation only. This file NEVER activates, NEVER moves the foreground on purpose,
#     NEVER changes Z-order, NEVER injects input, and NEVER calls a UIA pattern.
#   * The only Windows calls are: GetForegroundWindow, GetAncestor(GA_ROOT), EnumWindows,
#     GetWindowThreadProcessId, GetWindowText*, GetClassNameW, IsWindowVisible, IsIconic,
#     and the documented IVirtualDesktopManager.GetWindowDesktopId (read side only;
#     MoveWindowToDesktop exists in the interface but is never called).
#   * ASCII-only (PowerShell 5.1 without BOM parses non-ASCII as ANSI).
# ============================================================

if (-not ('AmW3.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AmW3 {

  // Documented interface (shobjidl_core.h): IID_IVirtualDesktopManager
  [ComImport, Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IVirtualDesktopManager {
    void IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out int onCurrentDesktop);
    void GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
    void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  public static class Native {

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);

    private static IVirtualDesktopManager _vdm = null;
    private static string _err = "not-initialised";

    public static string VdInit() {
      if (_vdm != null) { return "ok"; }
      try {
        Type t = Type.GetTypeFromCLSID(new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"), true);
        object raw = Activator.CreateInstance(t);
        _vdm = (IVirtualDesktopManager)raw;
        _err = "ok";
        return "ok";
      } catch (Exception ex) {
        _err = ex.Message; _vdm = null;
        return "error: " + ex.Message;
      }
    }

    public static string VdGetDesktopId(IntPtr hWnd) {
      if (VdInit() != "ok") { return "unavailable"; }
      try { Guid g; _vdm.GetWindowDesktopId(hWnd, out g); return g.ToString(); }
      catch { return "unavailable"; }
    }

    // GA_ROOT = 2. Returns Zero for a Zero input; never guesses.
    public static IntPtr Root(IntPtr h) {
      if (h == IntPtr.Zero) { return IntPtr.Zero; }
      IntPtr r = GetAncestor(h, 2);
      return (r == IntPtr.Zero) ? h : r;
    }
  }
}
'@
}

# Enumerate every top-level window owned by a process named AppleMusic.
# Read-only: EnumWindows + pid/title/class/state queries, nothing else.
function Get-AmW3AmWindowList {
  $res = @{ processCount = 0; count = 0; windows = @(); error = '' }
  try {
    $pids = @(Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $res.processCount = $pids.Count
    if ($pids.Count -eq 0) { $res.error = 'no-applemusic-process'; return $res }
    $bag = New-Object System.Collections.ArrayList
    $cb = [AmW3.EnumWindowsProc]{
      param([IntPtr]$h, [IntPtr]$l)
      $wpid = 0
      [void][AmW3.Native]::GetWindowThreadProcessId($h, [ref]$wpid)
      if ($pids -contains [int]$wpid) {
        $len = [AmW3.Native]::GetWindowTextLengthW($h)
        $sb = New-Object System.Text.StringBuilder ([Math]::Max(8, $len + 2))
        [void][AmW3.Native]::GetWindowTextW($h, $sb, $sb.Capacity)
        $csb = New-Object System.Text.StringBuilder 256
        [void][AmW3.Native]::GetClassNameW($h, $csb, 256)
        [void]$bag.Add(@{
          hwnd    = [int64]$h
          root    = [int64][AmW3.Native]::Root($h)
          pid     = [int]$wpid
          title   = $sb.ToString()
          cls     = $csb.ToString()
          visible = [AmW3.Native]::IsWindowVisible($h)
          iconic  = [AmW3.Native]::IsIconic($h)
        })
      }
      return $true
    }
    [void][AmW3.Native]::EnumWindows($cb, [IntPtr]::Zero)
    $res.windows = @($bag.ToArray())
    $res.count = $res.windows.Count
  } catch { $res.error = $_.Exception.Message }
  return $res
}

# Same selection convention the 3.7C observation layer used: first visible window that has a
# title, else the first enumerated window. Reported explicitly so the convention is auditable.
function Get-AmW3PrimaryAmWindow($list) {
  $primary = $null
  if ($list.count -gt 0) {
    $main = @($list.windows | Where-Object { $_.visible -and $_.title -ne '' })
    if ($main.Count -eq 0) { $main = @($list.windows) }
    $primary = $main[0]
  }
  return $primary
}

function ConvertTo-AmW3JsonString([string]$s) {
  if ($null -eq $s) { return '' }
  return ($s -replace '\\', '\\\\') -replace '"', '\"' -replace "`r", ' ' -replace "`n", ' '
}

function Get-AmW3WindowsJson($tag, $list, $primary) {
  $parts = @()
  foreach ($w in $list.windows) {
    $parts += ('{"hwnd":' + $w.hwnd + ',"root":' + $w.root + ',"pid":' + $w.pid +
               ',"visible":' + $w.visible.ToString().ToLower() +
               ',"iconic":' + $w.iconic.ToString().ToLower() +
               ',"class":"' + (ConvertTo-AmW3JsonString $w.cls) + '"' +
               ',"title":"' + (ConvertTo-AmW3JsonString $w.title) + '"}')
  }
  $ph = 0
  if ($primary) { $ph = $primary.hwnd }
  return ('{"tag":"' + $tag + '","processCount":' + $list.processCount + ',"primaryHwnd":' + $ph +
          ',"windows":[' + ($parts -join ',') + ']}')
}
