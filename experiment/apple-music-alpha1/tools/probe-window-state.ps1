# ============================================================
# experiment/apple-music-alpha1/tools/probe-window-state.ps1
# READ-ONLY probe: current Apple Music window facts + UIA reachability + SMTC.
#
# This script MUST NOT change anything:
#   - no SetWindowLong / SetLayeredWindowAttributes / ShowWindow / SetForegroundWindow
#   - no activation, no clicks, no UIA patterns that mutate state
# It only reads Win32 window facts, the UIA root and the SMTC session.
#
# ASCII-only on purpose (Windows PowerShell 5.1 decodes BOM-less UTF-8 as ANSI).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe-window-state.ps1
# ============================================================
[CmdletBinding()]
param(
  [switch]$Json,
  [string]$ExpectedClass = 'WinUIDesktopWin32WindowClass'
)

$ErrorActionPreference = 'Stop'
$libPoc = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'apple-music-windows-control\poc\lib'
. (Join-Path $libPoc 'am-smtc.ps1')

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

if (-not ('Alpha1.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Alpha1Native {
  public const int GWL_STYLE = -16;
  public const int GWL_EXSTYLE = -20;
  public const long WS_EX_LAYERED = 0x00080000L;
  public const long WS_VISIBLE = 0x10000000L;

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
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
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
'@ -Language CSharp
}

function Get-Alpha1WindowClass([IntPtr]$Hwnd) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][Alpha1Native]::GetClassNameW($Hwnd, $sb, $sb.Capacity)
  return $sb.ToString()
}
function Get-Alpha1WindowTitle([IntPtr]$Hwnd) {
  $len = [Alpha1Native]::GetWindowTextLengthW($Hwnd)
  $sb = New-Object System.Text.StringBuilder ([Math]::Max(8, $len + 2))
  [void][Alpha1Native]::GetWindowTextW($Hwnd, $sb, $sb.Capacity)
  return $sb.ToString()
}

# Every top-level window owned by the AppleMusic process, with class + style facts.
function Get-Alpha1Candidates {
  $pids = @(Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $bag = New-Object System.Collections.ArrayList
  if ($pids.Count -eq 0) { return @() }
  $cb = [Alpha1Native+EnumWindowsProc]{
    param([IntPtr]$h, [IntPtr]$l)
    $wpid = 0
    [void][Alpha1Native]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($pids -contains [int]$wpid) {
      $ex = [Alpha1Native]::GetWindowLongPtr($h, [Alpha1Native]::GWL_EXSTYLE).ToInt64()
      $st = [Alpha1Native]::GetWindowLongPtr($h, [Alpha1Native]::GWL_STYLE).ToInt64()
      $layered = (($ex -band [Alpha1Native]::WS_EX_LAYERED) -ne 0)
      $alpha = $null; $ck = 0; $fl = 0
      if ($layered) {
        $a = [byte]0
        if ([Alpha1Native]::GetLayeredWindowAttributes($h, [ref]$ck, [ref]$a, [ref]$fl)) { $alpha = [int]$a }
      }
      $r = New-Object Alpha1Native+RECT
      [void][Alpha1Native]::GetWindowRect($h, [ref]$r)
      [void]$bag.Add([ordered]@{
        hwnd = [int64]$h
        pid = [int]$wpid
        class = (Get-Alpha1WindowClass $h)
        title = (Get-Alpha1WindowTitle $h)
        style = ('0x' + ('{0:X8}' -f $st))
        exStyle = ('0x' + ('{0:X8}' -f $ex))
        wsExLayered = $layered
        lwaAlpha = $alpha
        lwaFlags = $fl
        visible = [Alpha1Native]::IsWindowVisible($h)
        iconic = [Alpha1Native]::IsIconic($h)
        hung = [Alpha1Native]::IsHungAppWindow($h)
        rect = ('' + $r.Left + ',' + $r.Top + ' ' + ($r.Right - $r.Left) + 'x' + ($r.Bottom - $r.Top))
      })
    }
    return $true
  }
  [void][Alpha1Native]::EnumWindows($cb, [IntPtr]::Zero)
  return @($bag.ToArray())
}

# UIA reachability: root + a few stable reads. Nothing is invoked.
function Get-Alpha1Uia([IntPtr]$Hwnd) {
  $out = [ordered]@{ rootOk = $false; rootName = ''; rootClass = ''; rootControlType = ''
                     descendantCount = -1; editCount = -1; buttonCount = -1
                     sampleNames = @(); stage = '' }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
    if (-not $root) { $out.stage = 'AM_UI_NOT_FOUND'; return $out }
    $out.rootOk = $true
    $out.rootName = '' + $root.Current.Name
    $out.rootClass = '' + $root.Current.ClassName
    $out.rootControlType = '' + $root.Current.ControlType.ProgrammaticName
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)
    $out.descendantCount = $all.Count
    $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
    $btns = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
    $out.editCount = $edits.Count
    $out.buttonCount = $btns.Count
    $names = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt [Math]::Min(6, $btns.Count); $i++) {
      try { $n = '' + $btns.Item($i).Current.Name; if ($n) { [void]$names.Add($n) } } catch { }
    }
    $out.sampleNames = @($names.ToArray())
    $out.stage = 'OK'
  } catch { $out.stage = 'UIA_ERROR: ' + $_.Exception.Message }
  return $out
}

$proc = Get-Process -Name AppleMusic -ErrorAction SilentlyContinue
$candidates = Get-Alpha1Candidates
# Prefer the real main window: the WinUI class, visible and NOT minimized; then any WinUI window;
# then any visible window; then anything we found.
$winui = @($candidates | Where-Object { $_.class -eq $ExpectedClass })
$main = @($winui | Where-Object { $_.visible -and -not $_.iconic })
if ($main.Count -eq 0) { $main = @($winui | Where-Object { $_.visible }) }
if ($main.Count -eq 0) { $main = @($winui) }
if ($main.Count -eq 0) { $main = @($candidates | Where-Object { $_.visible }) }
if ($main.Count -eq 0) { $main = @($candidates) }
$result0 = $null

$result = [ordered]@{
  at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
  appleMusicProcessRunning = (@($proc).Count -gt 0)
  appleMusicPids = @(@($proc) | ForEach-Object { $_.Id })
  mainWindowHandleFromProcess = @(@($proc) | ForEach-Object { [int64]$_.MainWindowHandle }) -join ','
  expectedClass = $ExpectedClass
  candidateCount = @($candidates).Count
  candidates = @($candidates)
}

$sel = if (@($main).Count -gt 0) { $main[0] } else { $null }
$result['selectedHwnd'] = if ($sel) { $sel.hwnd } else { 0 }
$result['selectedClass'] = if ($sel) { $sel.class } else { '' }
$result['selectedClassMatches'] = if ($sel) { ($sel.class -eq $ExpectedClass) } else { $false }
$result['selectedExStyle'] = if ($sel) { $sel.exStyle } else { '' }
$result['selectedLayered'] = if ($sel) { $sel.wsExLayered } else { $false }
$result['selectedAlpha'] = if ($sel) { $sel.lwaAlpha } else { $null }
$result['selectedVisible'] = if ($sel) { $sel.visible } else { $false }
$result['selectedIconic'] = if ($sel) { $sel.iconic } else { $false }

if ($sel) {
  $result['uia'] = Get-Alpha1Uia ([IntPtr]$sel.hwnd)
} else {
  $result['uia'] = [ordered]@{ rootOk = $false; stage = 'NO_WINDOW' }
}
$smtc = Get-AmSmtcState
$result['smtc'] = [ordered]@{ ok = $smtc.ok; title = $smtc.title; artist = $smtc.artist; status = $smtc.status; pos = $smtc.pos; dur = $smtc.dur }

if ($Json) {
  $result | ConvertTo-Json -Depth 6
} else {
  Write-Host '=== Apple Music window probe (READ-ONLY) ==='
  Write-Host ('at            : ' + $result.at)
  Write-Host ('process       : running=' + $result.appleMusicProcessRunning + ' pids=' + ($result.appleMusicPids -join ','))
  Write-Host ('process hwnd  : ' + $result.mainWindowHandleFromProcess)
  Write-Host ('candidates    : ' + $result.candidateCount)
  foreach ($c in $result.candidates) {
    Write-Host ('  - hwnd=0x' + ('{0:X}' -f $c.hwnd) + ' pid=' + $c.pid + ' class=' + $c.class + ' title=[' + $c.title + ']')
    Write-Host ('    style=' + $c.style + ' exStyle=' + $c.exStyle + ' layered=' + $c.wsExLayered + ' alpha=' + $c.lwaAlpha + ' visible=' + $c.visible + ' iconic=' + $c.iconic + ' hung=' + $c.hung + ' rect=' + $c.rect)
  }
  Write-Host ('selected      : hwnd=' + $result.selectedHwnd + ' classMatches=' + $result.selectedClassMatches + ' layered=' + $result.selectedLayered + ' alpha=' + $result.selectedAlpha + ' visible=' + $result.selectedVisible)
  Write-Host ('UIA           : ' + ($result.uia | ConvertTo-Json -Compress))
  Write-Host ('SMTC          : ' + ($result.smtc | ConvertTo-Json -Compress))
}
