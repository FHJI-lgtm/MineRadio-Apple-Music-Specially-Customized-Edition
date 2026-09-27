# ============================================================
# experiment/apple-music-alpha1/lib/alpha-common.ps1
# Alpha=1 stealth experiment: window style facts + layered alpha + evidence.
#
# SCOPE / DISCIPLINE
#   * Only documented Win32 calls are used, and only these three mutate anything:
#       SetWindowLongPtr(GWL_EXSTYLE)        (add / remove WS_EX_LAYERED)
#       SetLayeredWindowAttributes(LWA_ALPHA) (alpha 1 / 255)
#       ShowWindow(SW_MINIMIZE)              (return the window to its pre-experiment state)
#     plus ShowWindow(SW_RESTORE) through the FROZEN Restore-AmWindow helper.
#   * No injection, no hooks, no patching, no registry, no elevation, no COM.
#   * Everything that reads the frozen chain does so by dot-sourcing it read-only.
#   * ASCII-only on purpose (Windows PowerShell 5.1 decodes BOM-less UTF-8 as ANSI).
# ============================================================

Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

if (-not ('Alpha1.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class Alpha1Native {
  public const int GWL_STYLE = -16;
  public const int GWL_EXSTYLE = -20;
  public const long WS_EX_LAYERED = 0x00080000L;
  public const uint LWA_ALPHA = 0x00000002;
  public const int SW_MINIMIZE = 6;
  public const int SW_MAXIMIZE = 3;
  public const int SW_RESTORE = 9;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const long WS_EX_TRANSPARENT = 0x00000020L;
  public static readonly IntPtr HWND_TOP = IntPtr.Zero;
  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public static bool IsTransparent(IntPtr h) { return (ExStyle(h) & WS_EX_TRANSPARENT) != 0; }
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint colorKey, byte alpha, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetLayeredWindowAttributes(IntPtr hWnd, out uint colorKey, out byte alpha, out uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  public static long ExStyle(IntPtr h) { return GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64(); }
  public static long Style(IntPtr h) { return GetWindowLongPtr(h, GWL_STYLE).ToInt64(); }
  public static bool IsLayered(IntPtr h) { return (ExStyle(h) & WS_EX_LAYERED) != 0; }

  // alpha: -1 = unreadable (not layered / call failed)
  public static int ReadAlpha(IntPtr h) {
    if (!IsLayered(h)) return -1;
    uint ck = 0; byte a = 0; uint fl = 0;
    if (!GetLayeredWindowAttributes(h, out ck, out a, out fl)) return -1;
    return (int)a;
  }
  public static string ReadLayeredFlags(IntPtr h) {
    if (!IsLayered(h)) return "none";
    uint ck = 0; byte a = 0; uint fl = 0;
    if (!GetLayeredWindowAttributes(h, out ck, out a, out fl)) return "unreadable";
    return "0x" + fl.ToString("X8") + " colorKey=0x" + ck.ToString("X8");
  }
  public static string ClassName(IntPtr h) { var sb = new StringBuilder(512); GetClassNameW(h, sb, sb.Capacity); return sb.ToString(); }
  public static string Title(IntPtr h) { int n = GetWindowTextLengthW(h); var sb = new StringBuilder(Math.Max(8, n + 2)); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString(); }
  public static string RectText(IntPtr h) { RECT r; if (!GetWindowRect(h, out r)) return ""; return r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top); }
}

public static class Alpha1Image {
  static byte[] ToBytes(Bitmap bmp) {
    BitmapData d = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      int len = Math.Abs(d.Stride) * d.Height;
      byte[] buf = new byte[len];
      Marshal.Copy(d.Scan0, buf, 0, len);
      return buf;
    } finally { bmp.UnlockBits(d); }
  }
  public static byte[] Screen(int x, int y, int w, int h) {
    try {
      using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        using (Graphics g = Graphics.FromImage(bmp)) {
          g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        }
        return ToBytes(bmp);
      }
    } catch { return null; }
  }
  public static byte[] Window(IntPtr hwnd, int w, int h) {
    try {
      using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        bool ok = false;
        using (Graphics g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          try { ok = Alpha1Native.PrintWindow(hwnd, hdc, 2); } finally { g.ReleaseHdc(hdc); }
        }
        if (!ok) return null;
        return ToBytes(bmp);
      }
    } catch { return null; }
  }
  public static bool Save(string path, byte[] bgra, int w, int h) {
    try {
      using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try { Marshal.Copy(bgra, 0, d.Scan0, Math.Min(bgra.Length, Math.Abs(d.Stride) * h)); } finally { bmp.UnlockBits(d); }
        bmp.Save(path, ImageFormat.Png);
      }
      return true;
    } catch { return false; }
  }
  public static double MeanLuma(byte[] a) {
    if (a == null || a.Length < 4) return -1;
    double sum = 0; int px = a.Length / 4;
    for (int i = 0; i + 3 < a.Length; i += 4) sum += a[i] + a[i + 1] + a[i + 2];
    return sum / (px * 3.0);
  }
  // percentage of pixels whose summed RGB differs by more than the threshold
  public static double DiffPct(byte[] a, byte[] b) {
    if (a == null || b == null || a.Length != b.Length || a.Length < 4) return -1;
    long diff = 0; int px = a.Length / 4;
    for (int i = 0; i + 3 < a.Length; i += 4) {
      int la = a[i] + a[i + 1] + a[i + 2];
      int lb = b[i] + b[i + 1] + b[i + 2];
      if (Math.Abs(la - lb) > 24) diff++;
    }
    return 100.0 * diff / px;
  }
  // diff threshold 24 per summed RGB channel; returns a compact evidence string
  public static string Stats(byte[] a, byte[] b) {
    if (a == null) return "captureA=unavailable";
    if (b == null) return "captureB=unavailable";
    if (a.Length != b.Length) return "sizeMismatch(" + a.Length + " vs " + b.Length + ")";
    long diff = 0; double sa = 0; double sb = 0; int px = a.Length / 4;
    for (int i = 0; i + 3 < a.Length; i += 4) {
      int la = a[i] + a[i + 1] + a[i + 2];
      int lb = b[i] + b[i + 1] + b[i + 2];
      sa += la; sb += lb;
      if (Math.Abs(la - lb) > 24) diff++;
    }
    double denom = px * 3.0;
    return "diffPixels=" + diff + "/" + px + " diffPct=" + (px == 0 ? 0 : (100.0 * diff / px)).ToString("F2")
      + " meanLumaA=" + (sa / denom).ToString("F2") + " meanLumaB=" + (sb / denom).ToString("F2");
  }
}
'@ -Language CSharp -ReferencedAssemblies System.Drawing
}

function Get-Alpha1Stamp { return (Get-Date).ToString('yyyyMMdd-HHmmss') }
function Get-Alpha1Iso { return (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') }
function Get-Alpha1ReportDir {
  $d = Join-Path (Split-Path $PSScriptRoot -Parent) 'reports'
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  return $d
}
function Get-Alpha1ShotDir {
  $d = Join-Path (Get-Alpha1ReportDir) 'shots'
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  return $d
}

# ------------------------------------------------------------
# window facts
# ------------------------------------------------------------
function Get-Alpha1Windows {
  $pids = @(Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $bag = New-Object System.Collections.ArrayList
  if ($pids.Count -eq 0) { return @() }
  $cb = [Alpha1Native+EnumWindowsProc]{
    param([IntPtr]$h, [IntPtr]$l)
    $wpid = 0
    [void][Alpha1Native]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($pids -contains [int]$wpid) {
      $ex = [Alpha1Native]::ExStyle($h)
      $al = [Alpha1Native]::ReadAlpha($h)
      [void]$bag.Add([ordered]@{
        hwnd = [int64]$h
        hwndHex = ('0x' + ('{0:X}' -f [int64]$h))
        pid = [int]$wpid
        class = [Alpha1Native]::ClassName($h)
        title = [Alpha1Native]::Title($h)
        style = ('0x' + ('{0:X8}' -f [Alpha1Native]::Style($h)))
        exStyle = ('0x' + ('{0:X8}' -f $ex))
        layered = (($ex -band [Alpha1Native]::WS_EX_LAYERED) -ne 0)
        alpha = $al
        visible = [Alpha1Native]::IsWindowVisible($h)
        iconic = [Alpha1Native]::IsIconic($h)
        hung = [Alpha1Native]::IsHungAppWindow($h)
        rect = [Alpha1Native]::RectText($h)
      })
    }
    return $true
  }
  [void][Alpha1Native]::EnumWindows($cb, [IntPtr]::Zero)
  return @($bag.ToArray())
}

# Target = the WinUI main window. Preference order:
#   1. WinUI class + UIA root name 'Apple Music'
#   2. process MainWindowHandle (when it is a WinUI-class window)
#   3. WinUI class + visible + not iconic
#   4. WinUI class + visible
#   5. first WinUI class window
function Select-Alpha1Target([string]$WinUiClass = 'WinUIDesktopWin32WindowClass') {
  $all = @(Get-Alpha1Windows)
  $winui = @($all | Where-Object { $_.class -eq $WinUiClass })
  $sel = $null
  $why = ''
  foreach ($w in $winui) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$w.hwnd)
      if ($root -and ('' + $root.Current.Name) -eq 'Apple Music') { $sel = $w; $why = 'uia-name'; break }
    } catch { }
  }
  if (-not $sel) {
    $p = Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p -and $p.MainWindowHandle -ne 0) {
      $m = @($winui | Where-Object { $_.hwnd -eq [int64]$p.MainWindowHandle })
      if ($m.Count -gt 0) { $sel = $m[0]; $why = 'process-main-window' }
    }
  }
  if (-not $sel) { $v = @($winui | Where-Object { $_.visible -and -not $_.iconic }); if ($v.Count -gt 0) { $sel = $v[0]; $why = 'visible-not-iconic' } }
  if (-not $sel) { $v = @($winui | Where-Object { $_.visible }); if ($v.Count -gt 0) { $sel = $v[0]; $why = 'visible' } }
  if (-not $sel -and $winui.Count -gt 0) { $sel = $winui[0]; $why = 'first-winui' }
  return [ordered]@{ selected = $sel; why = $why; windows = $all; winuiCount = $winui.Count }
}

function Get-Alpha1UiaRoot([IntPtr]$Hwnd, [int]$Retries = 6, [int]$DelayMs = 400) {
  for ($i = 0; $i -lt $Retries; $i++) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
      if ($root) {
        return [ordered]@{ ok = $true; root = $root; tries = ($i + 1); stage = 'OK'
          name = ('' + $root.Current.Name); className = ('' + $root.Current.ClassName)
          controlType = ('' + $root.Current.ControlType.ProgrammaticName) }
      }
    } catch { }
    Start-Sleep -Milliseconds $DelayMs
  }
  return [ordered]@{ ok = $false; root = $null; tries = $Retries; stage = 'AM_UI_NOT_FOUND'; name = ''; className = ''; controlType = '' }
}

# UIA reachability counts. Read-only.
function Get-Alpha1UiaCounts($Root) {
  $c = [ordered]@{ descendants = -1; edits = -1; buttons = -1; listItems = -1; error = '' }
  try {
    $all = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $c.descendants = $all.Count
    $c.edits = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit))).Count
    $c.buttons = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))).Count
    $c.listItems = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem))).Count
  } catch { $c.error = $_.Exception.Message }
  return $c
}

# Side-effect-free UIA operation: SetFocus on the enabled Edit + ScrollIntoView on a ListItem.
# It never invokes, selects, types, clicks or changes playlist/playback state.
function Invoke-Alpha1UiaAction($Root) {
  $r = [ordered]@{ setFocusAttempted = $false; setFocusOk = $false; setFocusElement = ''
                   hasKeyboardFocusAfter = $false; scrollIntoViewAttempted = $false; scrollIntoViewOk = $false
                   scrollItemName = ''; error = '' }
  try {
    $edits = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
    $target = $null
    for ($i = 0; $i -lt $edits.Count; $i++) {
      if ($edits.Item($i).Current.IsEnabled) { $target = $edits.Item($i); break }
    }
    if ($target) {
      $r.setFocusAttempted = $true
      $r.setFocusElement = ('' + $target.Current.Name) + '|' + ('' + $target.Current.AutomationId)
      try { $target.SetFocus(); Start-Sleep -Milliseconds 120; $r.setFocusOk = $true } catch { $r.error += ('setFocus:' + $_.Exception.Message + ';') }
      try { $r.hasKeyboardFocusAfter = [bool]$target.Current.HasKeyboardFocus } catch { }
    }
    $items = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)))
    for ($i = 0; $i -lt $items.Count; $i++) {
      $it = $items.Item($i)
      if (-not $it.Current.IsEnabled) { continue }
      $r.scrollItemName = ('' + $it.Current.Name)
      $r.scrollIntoViewAttempted = $true
      try {
        $sp = $it.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
        if ($sp) { $sp.ScrollIntoView(); $r.scrollIntoViewOk = $true }
      } catch { $r.error += ('scrollIntoView:' + $_.Exception.Message + ';') }
      break
    }
  } catch { $r.error += ('uiaAction:' + $_.Exception.Message + ';') }
  return $r
}

function Get-Alpha1Smtc {
  $s = Get-AmSmtcState
  return [ordered]@{ ok = $s.ok; title = $s.title; artist = $s.artist; status = $s.status; pos = $s.pos; dur = $s.dur; posMs = $s.posMs }
}

# ------------------------------------------------------------
# evidence: SCREEN_TRUTH (what the user sees) + RENDER_TRUTH (what WinUI draws)
# ------------------------------------------------------------
function Save-Alpha1Shots([IntPtr]$Hwnd, [string]$Tag) {
  $out = [ordered]@{ tag = $Tag; rect = ''; width = 0; height = 0
                     screenPath = ''; renderPath = ''; screenOk = $false; renderOk = $false
                     error = '' }
  try {
    $rt = [Alpha1Native]::RectText($Hwnd)
    $out.rect = $rt
    $m = [regex]::Match($rt, '^(-?\d+),(-?\d+) (\d+)x(\d+)$')
    if (-not $m.Success) { $out.error = 'rect-unparsable'; return $out }
    $x = [int]$m.Groups[1].Value; $y = [int]$m.Groups[2].Value
    $w = [int]$m.Groups[3].Value; $h = [int]$m.Groups[4].Value
    $out.width = $w; $out.height = $h
    if ($w -le 0 -or $h -le 0) { $out.error = 'rect-empty'; return $out }
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $onScreen = ($x + $w -gt $vs.Left) -and ($x -lt ($vs.Left + $vs.Width)) -and ($y + $h -gt $vs.Top) -and ($y -lt ($vs.Top + $vs.Height))
    $dir = Get-Alpha1ShotDir
    if ($onScreen) {
      $sp = Join-Path $dir ($Tag + '-screen.png')
      $screen = [Alpha1Image]::Screen($x, $y, $w, $h)
      if ($screen) { $out.screenOk = [Alpha1Image]::Save($sp, $screen, $w, $h); $out.screenPath = $sp
                     Set-Content -Path ($sp + '.stats') -Value ([Alpha1Image]::Stats($screen, $screen)) -Encoding ASCII }
      else { $out.error += 'screen-capture-failed;' }
    } else { $out.error += 'rect-offscreen;' }
    $rp = Join-Path $dir ($Tag + '-render.png')
    $render = [Alpha1Image]::Window($Hwnd, $w, $h)
    if ($render) { $out.renderOk = [Alpha1Image]::Save($rp, $render, $w, $h); $out.renderPath = $rp }
    else { $out.error += 'printwindow-failed;' }
    $out['screenBuf'] = $screen
    $out['renderBuf'] = $render
  } catch { $out.error += $_.Exception.Message }
  return $out
}

# Strip the in-memory pixel buffers before serialising a shot record to JSON.
function Get-Alpha1ShotForJson($Shot) {
  $c = [ordered]@{}
  foreach ($k in $Shot.Keys) { if ($k -ne 'screenBuf' -and $k -ne 'renderBuf') { $c[$k] = $Shot[$k] } }
  return $c
}

# Pixel comparison between two shot records, using the buffers captured at shot time.
function Compare-Alpha1ShotBuffers($A, $B) {
  return [ordered]@{
    screen = if ($A -and $B -and $A.screenOk -and $B.screenOk) { [Alpha1Image]::Stats($A.screenBuf, $B.screenBuf) } else { 'unavailable' }
    render = if ($A -and $B -and $A.renderOk -and $B.renderOk) { [Alpha1Image]::Stats($A.renderBuf, $B.renderBuf) } else { 'unavailable' }
  }
}

# Compare two shot records (screen-vs-screen or render-vs-render).
# ------------------------------------------------------------
# the ONLY mutating calls
# ------------------------------------------------------------
function Apply-Alpha1([IntPtr]$Hwnd, [int]$Alpha) {
  $r = [ordered]@{ hwnd = [int64]$Hwnd; requestedAlpha = $Alpha
                   exStyleBefore = ('0x' + ('{0:X8}' -f [Alpha1Native]::ExStyle($Hwnd)))
                   layeredBefore = [Alpha1Native]::IsLayered($Hwnd)
                   addedLayered = $false; setStyleOk = $null; setStyleError = 0
                   setAttrOk = $false; setAttrError = 0
                   observedAlpha = -1; layeredAfter = $false; error = '' }
  try {
    if (-not [Alpha1Native]::IsLayered($Hwnd)) {
      $ex = [Alpha1Native]::ExStyle($Hwnd)
      $want = $ex -bor [Alpha1Native]::WS_EX_LAYERED
      [void][Alpha1Native]::SetWindowLongPtr($Hwnd, [Alpha1Native]::GWL_EXSTYLE, [IntPtr]$want)
      $r.setStyleOk = ([Alpha1Native]::ExStyle($Hwnd) -band [Alpha1Native]::WS_EX_LAYERED) -ne 0
      # Only read the Win32 last-error when the call FAILED; after a success it is a stale value
      # from an unrelated earlier call (the first run recorded 203 = ERROR_ENVVAR_NOT_FOUND).
      if (-not $r.setStyleOk) { $r.setStyleError = [int][System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
      $r.addedLayered = $true
      if (-not $r.setStyleOk) { $r.error += 'WS_EX_LAYERED not applied;' }
    }
    $ok = [Alpha1Native]::SetLayeredWindowAttributes($Hwnd, 0, [byte]$Alpha, [Alpha1Native]::LWA_ALPHA)
    $r.setAttrOk = [bool]$ok
    if (-not $ok) { $r.setAttrError = [int][System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    $r.observedAlpha = [Alpha1Native]::ReadAlpha($Hwnd)
    $r.layeredAfter = [Alpha1Native]::IsLayered($Hwnd)
  } catch { $r.error += $_.Exception.Message }
  return $r
}

# alpha sample + classification (the hard acceptance rule: never judge by "looks transparent")
function Get-Alpha1Sample([IntPtr]$Hwnd, [int]$Requested) {
  $ex = [Alpha1Native]::ExStyle($Hwnd)
  $layered = (($ex -band [Alpha1Native]::WS_EX_LAYERED) -ne 0)
  $alpha = [Alpha1Native]::ReadAlpha($Hwnd)
  $cls = 'UNKNOWN'
  if (-not $layered) { $cls = 'LAYERED_MISSING' }
  elseif ($alpha -lt 0) { $cls = 'UNREADABLE' }
  elseif ($alpha -eq $Requested) { $cls = 'HELD' }
  elseif ($alpha -eq 255) { $cls = 'RESTORED_TO_255' }
  else { $cls = ('CHANGED_TO_' + $alpha) }
  return [ordered]@{ at = (Get-Alpha1Iso); hwnd = [int64]$Hwnd; layered = $layered
                     transparent = (($ex -band [Alpha1Native]::WS_EX_TRANSPARENT) -ne 0)
                     exStyle = ('0x' + ('{0:X8}' -f $ex)); requestedAlpha = $Requested
                     observedAlpha = $alpha; classification = $cls
                     flags = [Alpha1Native]::ReadLayeredFlags($Hwnd)
                     visible = [Alpha1Native]::IsWindowVisible($Hwnd); iconic = [Alpha1Native]::IsIconic($Hwnd)
                     hung = [Alpha1Native]::IsHungAppWindow($Hwnd); isWindow = [Alpha1Native]::IsWindow($Hwnd)
                     rect = [Alpha1Native]::RectText($Hwnd) }
}

function Restore-Alpha1([IntPtr]$Hwnd, $Recipe, [switch]$SkipMinimize) {
  $r = [ordered]@{ ok = $false; alphaSetTo255 = $false; layeredRemoved = $false
                   exStyleBefore = ('0x' + ('{0:X8}' -f [Alpha1Native]::ExStyle($Hwnd)))
                   exStyleAfter = ''; exStyleExpected = ''; matchesOriginal = $false
                   minimized = $false; error = '' }
  try {
    [void][Alpha1Native]::SetLayeredWindowAttributes($Hwnd, 0, [byte]255, [Alpha1Native]::LWA_ALPHA)
    $r.alphaSetTo255 = ([Alpha1Native]::ReadAlpha($Hwnd) -eq 255)
    if ($Recipe -and ($Recipe.addedLayered -or $Recipe.addedTransparent)) {
      [void][Alpha1Native]::SetWindowLongPtr($Hwnd, [Alpha1Native]::GWL_EXSTYLE, [IntPtr][int64]$Recipe.originalExStyle)
      $r.layeredRemoved = -not [Alpha1Native]::IsLayered($Hwnd)
    }
    $r.exStyleAfter = ('0x' + ('{0:X8}' -f [Alpha1Native]::ExStyle($Hwnd)))
    $r.exStyleExpected = if ($Recipe) { ('0x' + ('{0:X8}' -f [int64]$Recipe.originalExStyle)) } else { $r.exStyleBefore }
    $r.matchesOriginal = ($r.exStyleAfter -eq $r.exStyleExpected)
    if ($Recipe -and $Recipe.preIconic -and -not $SkipMinimize) {
      [void][Alpha1Native]::ShowWindow($Hwnd, [Alpha1Native]::SW_MINIMIZE)
      Start-Sleep -Milliseconds 400
      $r.minimized = [Alpha1Native]::IsIconic($Hwnd)
    }
    $r.ok = $r.matchesOriginal
  } catch { $r.error = $_.Exception.Message }
  return $r
}

# Return the window to the pre-experiment minimized state (only called at the very end).
function Set-Alpha1WindowMinimized([IntPtr]$Hwnd) {
  $r = [ordered]@{ before = (Get-Alpha1Sample $Hwnd 255); minimized = $false; after = $null }
  try {
    [void][Alpha1Native]::ShowWindow($Hwnd, [Alpha1Native]::SW_MINIMIZE)
    Start-Sleep -Milliseconds 500
    $r.minimized = [Alpha1Native]::IsIconic($Hwnd)
  } catch { }
  $r.after = Get-Alpha1Sample $Hwnd 255
  return $r
}

function Write-Alpha1Recipe([string]$Stamp, $Recipe) {
  $p = Join-Path (Get-Alpha1ReportDir) ($Stamp + '.restore.json')
  # Write through .NET instead of the PowerShell pipeline: re-writing the same recipe with
  # Set-Content once failed with 'Stream was not readable' and left the file EMPTY, which would
  # have broken the disaster-recovery path. No BOM either.
  $json = $Recipe | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))
  return $p
}
function Read-Alpha1Recipe([string]$Path) {
  return (Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

# ------------------------------------------------------------
# UIA stress helpers (used ONLY to test whether an interaction makes Apple Music
# restore alpha). All of them are non-destructive: focus, scroll-into-view and a
# sidebar page selection. No playback, no like/collect, no account, no typing.
# ------------------------------------------------------------
function Find-Alpha1ListItems($Root) {
  return $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)))
}

# The sidebar entries are the first ListItems in the tree; report name + selected flag.
function Get-Alpha1NavItems($Root, [int]$Max = 16) {
  $out = New-Object System.Collections.ArrayList
  $items = Find-Alpha1ListItems $Root
  for ($i = 0; $i -lt [Math]::Min($Max, [int]$items.Count); $i++) {
    $it = $items.Item($i)
    $sel = $false
    try {
      $p = $it.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($p) { $sel = [bool]$p.Current.IsSelected }
    } catch { }
    [void]$out.Add([ordered]@{ index = $i; name = ('' + $it.Current.Name); selected = $sel; enabled = [bool]$it.Current.IsEnabled })
  }
  return @($out.ToArray())
}

function Invoke-Alpha1FocusSearch($Root) {
  $r = [ordered]@{ ok = $false; how = ''; element = ''; hasKeyboardFocus = $false; error = '' }
  try {
    $edits = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
    for ($i = 0; $i -lt [int]$edits.Count; $i++) {
      $e = $edits.Item($i)
      if (-not $e.Current.IsEnabled) { continue }
      $r.element = ('' + $e.Current.Name) + '|' + ('' + $e.Current.AutomationId)
      try {
        $e.SetFocus()
        $r.ok = $true; $r.how = 'SetFocus'
        Start-Sleep -Milliseconds 150
        $r.hasKeyboardFocus = [bool]$e.Current.HasKeyboardFocus
      } catch { $r.error = $_.Exception.Message }
      break
    }
  } catch { $r.error = $_.Exception.Message }
  return $r
}

function Invoke-Alpha1ScrollItemAt($Root, [int]$Wanted) {
  $r = [ordered]@{ ok = $false; how = ''; name = ''; index = -1; error = '' }
  try {
    $items = Find-Alpha1ListItems $Root
    $seen = 0
    for ($i = 0; $i -lt [int]$items.Count; $i++) {
      $it = $items.Item($i)
      if (-not $it.Current.IsEnabled) { continue }
      $nm = '' + $it.Current.Name
      if ($nm -eq '') { continue }
      if ($seen -lt $Wanted) { $seen++; continue }
      $r.name = $nm; $r.index = $i
      try {
        $sp = $it.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
        if ($sp) { $sp.ScrollIntoView(); $r.ok = $true; $r.how = 'ScrollItemPattern.ScrollIntoView' }
        else { $r.error = 'ScrollItemPattern unavailable' }
      } catch { $r.error = $_.Exception.Message }
      break
    }
  } catch { $r.error = $_.Exception.Message }
  return $r
}

# Sidebar page selection - the deliberate "re-render" trigger of this stress test.
function Invoke-Alpha1NavSelect($Root, [string]$Name) {
  $r = [ordered]@{ ok = $false; how = ''; name = $Name; index = -1; error = '' }
  try {
    $items = Find-Alpha1ListItems $Root
    for ($i = 0; $i -lt [int]$items.Count; $i++) {
      $it = $items.Item($i)
      if (('' + $it.Current.Name) -ne $Name) { continue }
      $r.index = $i
      try {
        $p = $it.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($p) { $p.Select(); $r.ok = $true; $r.how = 'SelectionItemPattern.Select' }
      } catch { $r.error += ('select:' + $_.Exception.Message + ';') }
      if (-not $r.ok) {
        try { $it.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $r.ok = $true; $r.how = 'InvokePattern.Invoke' } catch { $r.error += ('invoke:' + $_.Exception.Message + ';') }
      }
      break
    }
    if (-not $r.ok -and $r.index -lt 0) { $r.error += 'nav-item-not-found;' }
  } catch { $r.error += $_.Exception.Message }
  return $r
}

# Read-only input fact: with alpha applied, which top-level window would receive a click at a
# point inside the Apple Music rect? If it is still Apple Music, the invisible window keeps
# swallowing mouse input (alpha alone does not make it click-through).
function Get-Alpha1HitTest([IntPtr]$Hwnd) {
  $r = [ordered]@{ point = ''; hwnd = 0; class = ''; title = ''; isTarget = $false; rootHwnd = 0; rootIsTarget = $false; error = '' }
  try {
    $rt = [Alpha1Native]::RectText($Hwnd)
    $m = [regex]::Match($rt, '^(-?[0-9]+),(-?[0-9]+) ([0-9]+)x([0-9]+)$')
    if (-not $m.Success) { $r.error = 'rect-unparsable'; return $r }
    $x = [int]$m.Groups[1].Value; $y = [int]$m.Groups[2].Value
    $w = [int]$m.Groups[3].Value; $h = [int]$m.Groups[4].Value
    if ($w -le 0 -or $h -le 0) { $r.error = 'rect-empty'; return $r }
    $px = $x + [int]($w / 2); $py = $y + [int]($h / 2)
    $r.point = ($px.ToString() + ',' + $py.ToString())
    $pt = New-Object Alpha1Native+POINT
    $pt.X = $px; $pt.Y = $py
    $hit = [Alpha1Native]::WindowFromPoint($pt)
    $r.hwnd = [int64]$hit
    $r.class = [Alpha1Native]::ClassName($hit)
    $r.title = [Alpha1Native]::Title($hit)
    $r.isTarget = ([int64]$hit -eq [int64]$Hwnd)
    $rootHit = [Alpha1Native]::GetAncestor($hit, 2)
    $r.rootHwnd = [int64]$rootHit
    $r.rootIsTarget = ([int64]$rootHit -eq [int64]$Hwnd)
  } catch { $r.error = $_.Exception.Message }
  return $r
}

# ------------------------------------------------------------
# Click-through helpers (phase B: Alpha=1 + WS_EX_TRANSPARENT)
# ------------------------------------------------------------

# A point inside the window rect that is NOT covered by any interactive UIA element, so a real
# click there cannot change Apple Music's state. Rejects points inside the bounds of
# Button / ListItem / Edit / Hyperlink / TabItem / ComboBox / CheckBox / MenuItem / TreeItem.
function Get-Alpha1BlankSpot($Root, [IntPtr]$Hwnd, [int]$Grid = 40) {
  $r = [ordered]@{ ok = $false; x = 0; y = 0; reason = ''; scanned = 0; rejected = 0; interactiveElements = 0 }
  try {
    $rt = [Alpha1Native]::RectText($Hwnd)
    $m = [regex]::Match($rt, '^(-?[0-9]+),(-?[0-9]+) ([0-9]+)x([0-9]+)$')
    if (-not $m.Success) { $r.reason = 'rect-unparsable'; return $r }
    $x0 = [int]$m.Groups[1].Value; $y0 = [int]$m.Groups[2].Value
    $w = [int]$m.Groups[3].Value; $h = [int]$m.Groups[4].Value
    if ($w -lt 200 -or $h -lt 200) { $r.reason = 'rect-too-small'; return $r }
    # The maximized rect extends past the screen (invisible borders), and a point outside the
    # screen cannot be clicked (SetCursorPos clamps), so scan only the visible intersection.
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $margin = 60
    $vx = [Math]::Max($x0, $vs.Left + $margin)
    $vy = [Math]::Max($y0, $vs.Top + $margin)
    $vr = [Math]::Min($x0 + $w, $vs.Left + $vs.Width - $margin)
    $vb = [Math]::Min($y0 + $h, $vs.Top + $vs.Height - $margin)
    $r['virtualScreen'] = ('' + $vs.Left + ',' + $vs.Top + ' ' + $vs.Width + 'x' + $vs.Height)
    $r['scanBounds'] = ('' + $vx + ',' + $vy + ' ' + ($vr - $vx) + 'x' + ($vb - $vy))
    if (($vr - $vx) -lt 200 -or ($vb - $vy) -lt 200) { $r.reason = 'visible-intersection-too-small'; return $r }
    $types = @{}
    $types['Button'] = [System.Windows.Automation.ControlType]::Button
    $types['ListItem'] = [System.Windows.Automation.ControlType]::ListItem
    $types['Edit'] = [System.Windows.Automation.ControlType]::Edit
    $types['Hyperlink'] = [System.Windows.Automation.ControlType]::Hyperlink
    $types['TabItem'] = [System.Windows.Automation.ControlType]::TabItem
    $types['ComboBox'] = [System.Windows.Automation.ControlType]::ComboBox
    $types['CheckBox'] = [System.Windows.Automation.ControlType]::CheckBox
    $types['MenuItem'] = [System.Windows.Automation.ControlType]::MenuItem
    $types['TreeItem'] = [System.Windows.Automation.ControlType]::TreeItem
    $boxes = New-Object System.Collections.ArrayList
    foreach ($k in $types.Keys) {
      try {
        $found = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
          (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $types[$k])))
        for ($i = 0; $i -lt [int]$found.Count; $i++) {
          $b = $found.Item($i).Current.BoundingRectangle
          if ($b.Width -gt 1 -and $b.Height -gt 1) {
            [void]$boxes.Add(@{ l = [double]$b.Left; t = [double]$b.Top; rr = [double]$b.Right; bb = [double]$b.Bottom })
          }
        }
      } catch { }
    }
    $r.interactiveElements = $boxes.Count
    # scan bottom-left upwards (sidebar footer / blank margins are the least interactive areas)
    for ($y = $vb - $Grid; $y -gt $vy + [int](($vb - $vy) / 3); $y -= $Grid) {
      for ($x = $vx + $Grid; $x -lt $vx + [int](($vr - $vx) / 2); $x += $Grid) {
        $r.scanned = $r.scanned + 1
        $inside = $false
        foreach ($bx in $boxes) {
          if ($x -ge $bx.l -and $x -le $bx.rr -and $y -ge $bx.t -and $y -le $bx.bb) { $inside = $true; break }
        }
        if ($inside) { $r.rejected = $r.rejected + 1; continue }
        $r.ok = $true; $r.x = $x; $r.y = $y; $r.reason = 'blank-inside-rect'
        return $r
      }
    }
    $r.reason = 'no-blank-spot'
  } catch { $r.reason = $_.Exception.Message }
  return $r
}

# A tiny owned receiver window placed BEHIND Apple Music at the sample point. It counts real
# MouseDown events, which is how we tell WHO actually received the click.
function New-Alpha1Receiver([int]$CenterX, [int]$CenterY, [int]$W = 140, [int]$H = 90) {
  $script:Alpha1ReceiverLeftLog = New-Object System.Collections.ArrayList
  $script:Alpha1ReceiverRightLog = New-Object System.Collections.ArrayList
  $script:Alpha1ReceiverWheelLog = New-Object System.Collections.ArrayList
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.ShowInTaskbar = $false
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Location = New-Object System.Drawing.Point(($CenterX - [int]($W / 2)), ($CenterY - [int]($H / 2)))
  $form.Size = New-Object System.Drawing.Size($W, $H)
  $form.TopMost = $false
  $form.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 28)
  $form.Add_MouseDown({
    $btn = 'Left'
    try { $btn = [string]$args[1].Button } catch { }
    $stamp = (Get-Date).ToString('HH:mm:ss.fff')
    if ($btn -eq 'Right') { [void]$script:Alpha1ReceiverRightLog.Add($stamp) }
    else { [void]$script:Alpha1ReceiverLeftLog.Add($stamp) }
  })
  $form.Add_MouseUp({ [void]$script:Alpha1ReceiverLeftLog.Add(('up:' + (Get-Date).ToString('HH:mm:ss.fff'))) })
  $form.Add_MouseWheel({ [void]$script:Alpha1ReceiverWheelLog.Add((Get-Date).ToString('HH:mm:ss.fff')) })
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 250
  return $form
}
function Get-Alpha1ReceiverHits { return [int]($script:Alpha1ReceiverLeftLog.Count + $script:Alpha1ReceiverRightLog.Count) }
function Get-Alpha1ReceiverCounts {
  return [ordered]@{ left = [int]$script:Alpha1ReceiverLeftLog.Count; right = [int]$script:Alpha1ReceiverRightLog.Count; wheel = [int]$script:Alpha1ReceiverWheelLog.Count }
}
function Close-Alpha1Receiver($Form) {
  try { $Form.Close(); $Form.Dispose() } catch { }
  try { [System.Windows.Forms.Application]::DoEvents() } catch { }
}
# Put the receiver DIRECTLY BELOW Apple Music in the z-order (no activation), so that the only
# window that can hide it from a hit test is Apple Music itself.
function Set-Alpha1ReceiverBelow([IntPtr]$Receiver, [IntPtr]$Above) {
  $f = [uint32]0x0001 -bor [uint32]0x0002 -bor [uint32]0x0010   # SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE
  $ok = [Alpha1Native]::SetWindowPos($Receiver, $Above, 0, 0, 0, 0, $f)
  return [ordered]@{ ok = [bool]$ok; win32Error = [int][System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
}
function Invoke-Alpha1RealClick([int]$X, [int]$Y, [string]$Button = 'Left') {
  $r = [ordered]@{ ok = $false; at = (Get-Alpha1Iso); x = $X; y = $Y; error = '' }
  try {
    [void][Alpha1Native]::SetCursorPos($X, $Y)
    $cp = [System.Windows.Forms.Cursor]::Position
    $r['cursorAfterSet'] = ('' + $cp.X + ',' + $cp.Y)
    Start-Sleep -Milliseconds 150
    $downFlag = [Alpha1Native]::MOUSEEVENTF_LEFTDOWN
    $upFlag = [Alpha1Native]::MOUSEEVENTF_LEFTUP
    if ($Button -eq 'Right') { $downFlag = [Alpha1Native]::MOUSEEVENTF_RIGHTDOWN; $upFlag = [Alpha1Native]::MOUSEEVENTF_RIGHTUP }
    [Alpha1Native]::mouse_event($downFlag, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Alpha1Native]::mouse_event($upFlag, 0, 0, 0, [UIntPtr]::Zero)
    # Pump the receiver's message queue: without this the WM_LBUTTONDOWN we just synthesized
    # would sit in the queue and its handler would never run (false negative).
    for ($i = 0; $i -lt 20; $i++) {
      try { [System.Windows.Forms.Application]::DoEvents() } catch { }
      Start-Sleep -Milliseconds 25
    }
    $r.ok = $true
  } catch { $r.error = $_.Exception.Message }
  return $r
}
function Add-Alpha1Transparent([IntPtr]$Hwnd) {
  $before = [Alpha1Native]::ExStyle($Hwnd)
  $want = $before -bor [Alpha1Native]::WS_EX_TRANSPARENT
  [void][Alpha1Native]::SetWindowLongPtr($Hwnd, [Alpha1Native]::GWL_EXSTYLE, [IntPtr]$want)
  $after = [Alpha1Native]::ExStyle($Hwnd)
  return [ordered]@{ ok = (($after -band [Alpha1Native]::WS_EX_TRANSPARENT) -ne 0)
    exStyleBefore = ('0x' + ('{0:X8}' -f $before)); exStyleAfter = ('0x' + ('{0:X8}' -f $after))
    isTransparent = [Alpha1Native]::IsTransparent($Hwnd); alphaReadable = [Alpha1Native]::ReadAlpha($Hwnd) }
}
function Remove-Alpha1Transparent([IntPtr]$Hwnd) {
  $before = [Alpha1Native]::ExStyle($Hwnd)
  $want = [int64]$before -band (-bnot [int64][Alpha1Native]::WS_EX_TRANSPARENT)
  [void][Alpha1Native]::SetWindowLongPtr($Hwnd, [Alpha1Native]::GWL_EXSTYLE, [IntPtr][int64]$want)
  $after = [Alpha1Native]::ExStyle($Hwnd)
  return [ordered]@{ ok = (($after -band [Alpha1Native]::WS_EX_TRANSPARENT) -eq 0)
    exStyleBefore = ('0x' + ('{0:X8}' -f $before)); exStyleAfter = ('0x' + ('{0:X8}' -f $after))
    isTransparent = [Alpha1Native]::IsTransparent($Hwnd); alphaReadable = [Alpha1Native]::ReadAlpha($Hwnd) }
}

# Bounding boxes of every interactive UIA element (used to tag sweep points and to find blanks).
function Get-Alpha1InteractiveBoxes($Root) {
  $types = @{}
  $types['Button'] = [System.Windows.Automation.ControlType]::Button
  $types['ListItem'] = [System.Windows.Automation.ControlType]::ListItem
  $types['Edit'] = [System.Windows.Automation.ControlType]::Edit
  $types['Hyperlink'] = [System.Windows.Automation.ControlType]::Hyperlink
  $types['TabItem'] = [System.Windows.Automation.ControlType]::TabItem
  $types['ComboBox'] = [System.Windows.Automation.ControlType]::ComboBox
  $types['CheckBox'] = [System.Windows.Automation.ControlType]::CheckBox
  $types['MenuItem'] = [System.Windows.Automation.ControlType]::MenuItem
  $types['TreeItem'] = [System.Windows.Automation.ControlType]::TreeItem
  $out = New-Object System.Collections.ArrayList
  foreach ($k in $types.Keys) {
    try {
      $found = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $types[$k])))
      for ($i = 0; $i -lt [int]$found.Count; $i++) {
        $b = $found.Item($i).Current.BoundingRectangle
        if ($b.Width -gt 1 -and $b.Height -gt 1) {
          [void]$out.Add(@{ kind = $k; name = ('' + $found.Item($i).Current.Name); l = [double]$b.Left; t = [double]$b.Top; rr = [double]$b.Right; bb = [double]$b.Bottom })
        }
      }
    } catch { }
  }
  return @($out.ToArray())
}
function Test-Alpha1PointInBoxes([int]$X, [int]$Y, $Boxes) {
  foreach ($b in $Boxes) { if ($X -ge $b.l -and $X -le $b.rr -and $Y -ge $b.t -and $Y -le $b.bb) { return [string]$b.kind } }
  return ''
}

# Real wheel event at a point (WM_MOUSEWHEEL routing depends on the system setting
# HKCU:\Control Panel\Desktop\MouseWheelRouting; the runner records it).
function Invoke-Alpha1RealWheel([int]$X, [int]$Y, [int]$Delta = 120) {
  $r = [ordered]@{ ok = $false; x = $X; y = $Y; delta = $Delta; error = '' }
  try {
    [void][Alpha1Native]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 150
    [Alpha1Native]::mouse_event([Alpha1Native]::MOUSEEVENTF_WHEEL, 0, 0, [uint32]$Delta, [UIntPtr]::Zero)
    for ($i = 0; $i -lt 12; $i++) { try { [System.Windows.Forms.Application]::DoEvents() } catch { } ; Start-Sleep -Milliseconds 25 }
    $r.ok = $true
  } catch { $r.error = $_.Exception.Message }
  return $r
}

# ------------------------------------------------------------
# UIA scroll helpers for round 3 (ScrollPattern / ScrollItemPattern only - never mouse wheel).
# The frozen lib's Scroll-AmView is mouse-wheel based (it would scroll the window BELOW a
# click-through Apple Music), so this round uses the UIA provider instead.
# ------------------------------------------------------------
function Get-Alpha1ScrollTargets($Root) {
  $out = New-Object System.Collections.ArrayList
  $all = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  for ($i = 0; $i -lt [int]$all.Count; $i++) {
    $el = $all.Item($i)
    $hasScroll = $false
    try { $hasScroll = [bool]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty) } catch { }
    if (-not $hasScroll) { continue }
    try {
      $sp = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
      $b = $el.Current.BoundingRectangle
      [void]$out.Add([ordered]@{
        index = $i; name = ('' + $el.Current.Name); automationId = ('' + $el.Current.AutomationId)
        controlType = ('' + $el.Current.ControlType.ProgrammaticName)
        runtimeId = (@($el.GetRuntimeId()) -join '.');
        area = [int]($b.Width * $b.Height); width = [int]$b.Width; height = [int]$b.Height
        verticallyScrollable = [bool]$sp.Current.VerticallyScrollable; horizontallyScrollable = [bool]$sp.Current.HorizontallyScrollable
        verticalPercent = [double]$sp.Current.VerticalScrollPercent; horizontalPercent = [double]$sp.Current.HorizontalScrollPercent
        verticalViewSize = [double]$sp.Current.VerticalViewSize; horizontalViewSize = [double]$sp.Current.HorizontalViewSize
        element = $el
      })
    } catch { }
  }
  return @($out.ToArray())
}
function Get-Alpha1ScrollState($Element) {
  try {
    $sp = $Element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    return [ordered]@{ ok = $true; verticallyScrollable = [bool]$sp.Current.VerticallyScrollable; horizontallyScrollable = [bool]$sp.Current.HorizontallyScrollable
      verticalPercent = [double]$sp.Current.VerticalScrollPercent; horizontalPercent = [double]$sp.Current.HorizontalScrollPercent
      verticalViewSize = [double]$sp.Current.VerticalViewSize; horizontalViewSize = [double]$sp.Current.HorizontalViewSize }
  } catch { return [ordered]@{ ok = $false; error = $_.Exception.Message } }
}
# Direction: 'down' | 'up' ; Amount: 'small' | 'large' | 'no'
function Invoke-Alpha1Scroll($Element, [string]$Direction, [string]$Amount = 'small') {
  $r = [ordered]@{ ok = $false; direction = $Direction; amount = $Amount; error = ''; before = $null; after = $null }
  try {
    $r.before = Get-Alpha1ScrollState $Element
    $sp = $Element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $v = [System.Windows.Automation.ScrollAmount]::NoAmount
    $h = [System.Windows.Automation.ScrollAmount]::NoAmount
    $amt = [System.Windows.Automation.ScrollAmount]::SmallIncrement
    if ($Amount -eq 'large') { $amt = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
    if ($Amount -eq 'no') { $amt = [System.Windows.Automation.ScrollAmount]::NoAmount }
    if ($Direction -eq 'down') { $v = $amt } elseif ($Direction -eq 'up') { $v = $amt; $v = -1 * [int]$amt } else { throw ('unknown direction ' + $Direction) }
    $sp.Scroll($h, $v)
    Start-Sleep -Milliseconds 400
    $r.after = Get-Alpha1ScrollState $Element
    $r.ok = $true
  } catch { $r.error = $_.Exception.Message }
  return $r
}
# ScrollPattern.ScrollAmount is an enum: down = positive, up = negative. Build it explicitly.
function Invoke-Alpha1ScrollEx($Element, [string]$Direction, [string]$Amount = 'small') {
  $r = [ordered]@{ ok = $false; direction = $Direction; amount = $Amount; error = ''; before = $null; after = $null }
  try {
    $r.before = Get-Alpha1ScrollState $Element
    $sp = $Element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $hAmt = [System.Windows.Automation.ScrollAmount]::NoAmount
    $vAmt = [System.Windows.Automation.ScrollAmount]::NoAmount
    if ($Amount -eq 'small') { $hAmt = [System.Windows.Automation.ScrollAmount]::SmallIncrement; $vAmt = [System.Windows.Automation.ScrollAmount]::SmallIncrement }
    if ($Amount -eq 'large') { $hAmt = [System.Windows.Automation.ScrollAmount]::LargeIncrement; $vAmt = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
    if ($Direction -eq 'up') {
      $upAmt = [System.Windows.Automation.ScrollAmount]::SmallDecrement
      if ($Amount -eq 'large') { $upAmt = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
      $sp.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $upAmt)
    } elseif ($Direction -eq 'down') {
      $sp.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $vAmt)
    } else { throw ('unknown direction ' + $Direction) }
    Start-Sleep -Milliseconds 400
    $r.after = Get-Alpha1ScrollState $Element
    $r.ok = $true
  } catch { $r.error = $_.Exception.Message }
  return $r
}
