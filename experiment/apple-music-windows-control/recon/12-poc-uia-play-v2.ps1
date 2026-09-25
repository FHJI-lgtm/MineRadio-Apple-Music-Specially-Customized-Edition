# ============================================================
# 12-poc-uia-play-v2.ps1   (PoC v2: realize the virtualized track row, then play it)
#
# v1 result: the target ListItem was found through UI Automation and exposes
#            InvokePattern / SelectionItemPattern / ScrollItemPattern / VirtualizedItemPattern,
#            but its BoundingRectangle was empty (virtualized, not realized), so Select()/Invoke()
#            had no effect and the synthesized double click hit nothing.
#
# v2 adds, in order:
#   1. ScrollItemPattern.ScrollIntoView()  +  VirtualizedItemPattern.Realize()
#   2. focus the element, re-read BoundingRectangle
#   3. SelectionItemPattern.Select() when a real rect exists
#   4. InvokePattern.Invoke()
#   5. synthesized double click at the row (left side, away from hover buttons)
#   6. Enter key after focus
#   ... verifying after every step through SMTC (title match + PlaybackStatus=Playing)
#
# Safety: official UI Automation + official SMTC (read + pause cleanup) only.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\12-poc-uia-play-v2.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$shotDir = Join-Path $outDir 'shots'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
$outFile = Join-Path $outDir '12-poc-uia-play-v2.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

$TITLE = 'How Do I Make You Love Me'

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Cap3 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
'@
try { Add-Type -TypeDefinition $sig -Language CSharp -ErrorAction Stop } catch { }

function Await($WinRtTask, [Type]$ResultType) {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(8000) | Out-Null
  return $netTask.Result
}
function Get-Session {
  try {
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    foreach ($s in $mgr.GetSessions()) { if (('' + $s.SourceAppUserModelId) -match 'AppleMusic') { return $s } }
  } catch { }
  return $null
}
function Get-Smtc {
  $out = @{ title = ''; artist = ''; status = ''; pos = ''; dur = '' }
  $s = Get-Session
  if (-not $s) { return $out }
  try {
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($p) { $out.title = '' + $p.Title; $out.artist = '' + $p.Artist }
    $i = $s.GetPlaybackInfo(); if ($i) { $out.status = '' + $i.PlaybackStatus }
    $t = $s.GetTimelineProperties(); if ($t) { $out.pos = '' + $t.Position; $out.dur = '' + $t.EndTime }
  } catch { }
  return $out
}
function IsPlayingTarget($s) {
  return (($s.title -match 'How Do I Make You Love Me') -and ($s.status -eq 'Playing'))
}
function Show-Smtc($s, [string]$tag) { Say ('  [' + $tag + '] title="' + $s.title + '" artist="' + $s.artist + '" status=' + $s.status + ' pos=' + $s.pos) }
function Save-Shot([string]$name) {
  $p = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq 0) { return }
  [Cap3]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
  [Cap3]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 500
  $r = New-Object Cap3+RECT
  [Cap3]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { return }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [Cap3]::PrintWindow($p.MainWindowHandle, $hdc, 2)
  $g.ReleaseHdc($hdc)
  if (-not $ok) { $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h)) }
  $bmp.Save((Join-Path $shotDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Say ('  screenshot: findings\shots\' + $name)
}

$proc = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue
if (-not $proc) { Say 'AppleMusic not running'; exit 1 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)

Say '=== PoC v2: realize + play the target row ==='
Show-Smtc (Get-Smtc) 'before'

$listCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
$items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)
Say ('  ListItems: ' + $items.Count)
$target = $null
for ($i = 0; $i -lt $items.Count; $i++) {
  $it = $items.Item($i)
  if (('' + $it.Current.Name) -match 'How Do I Make You Love Me') { $target = $it; break }
}
if (-not $target) { Say '  target row not found'; Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8; exit 2 }
Say ('  target: "' + $target.Current.Name + '"')

Say ''
Say '=== Step 1: realize / scroll into view ==='
try { $target.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView(); Say '  ScrollIntoView() ok' } catch { Say ('  ScrollIntoView failed: ' + $_.Exception.Message) }
Start-Sleep -Milliseconds 900
try { $target.GetCurrentPattern([System.Windows.Automation.VirtualizedItemPattern]::Pattern).Realize(); Say '  VirtualizedItem.Realize() ok' } catch { Say ('  Realize failed: ' + $_.Exception.Message) }
Start-Sleep -Milliseconds 900
try { $target.SetFocus(); Say '  SetFocus() ok' } catch { Say ('  SetFocus failed: ' + $_.Exception.Message) }
Start-Sleep -Milliseconds 600
$r = $target.Current.BoundingRectangle
Say ('  rect now: ' + $r.ToString() + '  isEmpty=' + $r.IsEmpty)

$played = $false
$clickX = 0; $clickY = 0
if (-not $r.IsEmpty) {
  $clickX = [int]($r.Left + [Math]::Min(300, $r.Width * 0.30))
  $clickY = [int]($r.Top + $r.Height / 2)
  Say ('  click point: ' + $clickX + ',' + $clickY)
}

Say ''
Say '=== Step 2: SelectionItemPattern.Select ==='
try { $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); Say '  Select() ok' } catch { Say ('  Select failed: ' + $_.Exception.Message) }
Start-Sleep -Seconds 3
Show-Smtc (Get-Smtc) 'after Select'
$played = IsPlayingTarget (Get-Smtc)

if (-not $played) {
  Say ''
  Say '=== Step 3: InvokePattern.Invoke ==='
  try { $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Say '  Invoke() ok' } catch { Say ('  Invoke failed: ' + $_.Exception.Message) }
  Start-Sleep -Seconds 3
  Show-Smtc (Get-Smtc) 'after Invoke'
  $played = IsPlayingTarget (Get-Smtc)
}

if (-not $played -and $clickX -gt 0) {
  Say ''
  Say '=== Step 4: double click at the row ==='
  [Cap3]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
  [Cap3]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 400
  [Cap3]::SetCursorPos($clickX, $clickY) | Out-Null
  Start-Sleep -Milliseconds 250
  [Cap3]::mouse_event(2, 0, 0, 0, 0); [Cap3]::mouse_event(4, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 130
  [Cap3]::mouse_event(2, 0, 0, 0, 0); [Cap3]::mouse_event(4, 0, 0, 0, 0)
  Say ('  double click issued at ' + $clickX + ',' + $clickY)
  Start-Sleep -Seconds 5
  Show-Smtc (Get-Smtc) 'after double click'
  $played = IsPlayingTarget (Get-Smtc)
}

if (-not $played) {
  Say ''
  Say '=== Step 5: single click then Enter ==='
  [Cap3]::SetCursorPos($clickX, $clickY) | Out-Null
  [Cap3]::mouse_event(2, 0, 0, 0, 0); [Cap3]::mouse_event(4, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Say '  click + Enter issued'
  Start-Sleep -Seconds 4
  Show-Smtc (Get-Smtc) 'after click+Enter'
  $played = IsPlayingTarget (Get-Smtc)
}

Say ''
Say '=== Result ==='
Show-Smtc (Get-Smtc) 'final'
Save-Shot '12-poc-uia-play-v2.png'
Say ('  precise playback succeeded = ' + $played)

if ($played) {
  Say ''
  Say '=== Cleanup: pause via SMTC (song stays selected) ==='
  try {
    $s = Get-Session
    $null = Await ($s.TryPauseAsync()) ([bool])
    Start-Sleep -Seconds 1
    Show-Smtc (Get-Smtc) 'after pause'
  } catch { Say ('  pause failed: ' + $_.Exception.Message) }
}

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
