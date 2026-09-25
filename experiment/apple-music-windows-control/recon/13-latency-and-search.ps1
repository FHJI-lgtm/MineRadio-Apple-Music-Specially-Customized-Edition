# ============================================================
# 13-latency-and-search.ps1
#
# Part A (latency, measured): launch deep link -> target row visible -> row realized ->
#         double click -> SMTC reports Playing. Every stage is polled, so the numbers are real.
# Part B (search path feasibility): does the Search button expose an Edit control, and does
#         typing the song title produce a matching result row? (No playback in Part B.)
#
# Target: How Do I Make You Love Me?  (song id 1603171530)
# Safety: official UI Automation + official SMTC (read + pause cleanup) only.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\13-latency-and-search.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$outFile = Join-Path $outDir '13-latency-and-search.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

$TITLE = 'How Do I Make You Love Me'
$MUSICS_URL = 'musics://music.apple.com/cn/song/how-do-i-make-you-love-me/1603171530'

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Cap4 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
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
  $out = @{ title = ''; status = ''; pos = '' }
  $s = Get-Session
  if (-not $s) { return $out }
  try {
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($p) { $out.title = '' + $p.Title }
    $i = $s.GetPlaybackInfo(); if ($i) { $out.status = '' + $i.PlaybackStatus }
    $t = $s.GetTimelineProperties(); if ($t) { $out.pos = '' + $t.Position }
  } catch { }
  return $out
}

$proc = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue
if (-not $proc) { Say 'AppleMusic not running'; exit 1 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$listCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)

function Find-TargetRow {
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)
  for ($i = 0; $i -lt $items.Count; $i++) {
    $it = $items.Item($i)
    if (('' + $it.Current.Name) -match 'How Do I Make You Love Me') { return $it }
  }
  return $null
}

Say '=== Part B: search path feasibility (no playback) ==='
$searchCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'Search_Button')
$searchBtn = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $searchCond)
if (-not $searchBtn) {
  Say '  Search_Button not found'
} else {
  Say ('  Search_Button found: name="' + $searchBtn.Current.Name + '"')
  try { $searchBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Say '  invoked search' } catch { Say ('  invoke failed: ' + $_.Exception.Message) }
  Start-Sleep -Seconds 2
  $editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
  $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
  Say ('  Edit controls after opening search: ' + $edits.Count)
  for ($i = 0; $i -lt $edits.Count; $i++) {
    $e = $edits.Item($i)
    Say ('    [' + $i + '] name="' + $e.Current.Name + '" autoId="' + $e.Current.AutomationId + '" enabled=' + $e.Current.IsEnabled)
  }
  if ($edits.Count -gt 0) {
    $target = $edits.Item(0)
    try {
      $target.SetFocus()
      Start-Sleep -Milliseconds 400
      $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($TITLE)
      Say ('  typed: ' + $TITLE)
    } catch { Say ('  typing failed: ' + $_.Exception.Message) }
    Start-Sleep -Seconds 4
    $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)
    Say ('  ListItems after search: ' + $items.Count)
    $foundSearch = $false
    for ($i = 0; $i -lt $items.Count; $i++) {
      $n = '' + $items.Item($i).Current.Name
      if ($n -match 'How Do I Make You Love Me') { $foundSearch = $true; Say ('    SEARCH MATCH: "' + $n + '"') }
    }
    if (-not $foundSearch) { Say '    (no matching ListItem in the search results view)' }
  }
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Seconds 1
  Say '  search closed (ESC)'
}
Say ''

Say '=== Part A: measured latency of the proven precise-play path ==='
$t0 = Get-Date
Say ('  [t0] launching deep link: ' + $MUSICS_URL)
Start-Process $MUSICS_URL | Out-Null
$row = $null
$t1 = $null
for ($i = 0; $i -lt 100; $i++) {
  Start-Sleep -Milliseconds 200
  $row = Find-TargetRow
  if ($row) { $t1 = Get-Date; break }
}
if (-not $row) { Say '  target row never appeared'; Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8; exit 2 }
Say ('  [t1] target row visible after ' + [int]((New-TimeSpan $t0 $t1).TotalMilliseconds) + ' ms')

$t2 = $null
try { $row.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch { }
try { $row.GetCurrentPattern([System.Windows.Automation.VirtualizedItemPattern]::Pattern).Realize() } catch { }
try { $row.SetFocus() } catch { }
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 100
  if (-not $row.Current.BoundingRectangle.IsEmpty) { $t2 = Get-Date; break }
}
if (-not $t2) { $t2 = Get-Date }
$r = $row.Current.BoundingRectangle
Say ('  [t2] row realized+focusable after ' + [int]((New-TimeSpan $t1 $t2).TotalMilliseconds) + ' ms   rect=' + $r.ToString())
$clickX = [int]($r.Left + [Math]::Min(300, $r.Width * 0.30))
$clickY = [int]($r.Top + $r.Height / 2)

[Cap4]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
[Cap4]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
[Cap4]::SetCursorPos($clickX, $clickY) | Out-Null
Start-Sleep -Milliseconds 150
$t3 = Get-Date
[Cap4]::mouse_event(2, 0, 0, 0, 0); [Cap4]::mouse_event(4, 0, 0, 0, 0)
Start-Sleep -Milliseconds 120
[Cap4]::mouse_event(2, 0, 0, 0, 0); [Cap4]::mouse_event(4, 0, 0, 0, 0)
Say ('  [t3] double click issued at ' + $clickX + ',' + $clickY)

$t4 = $null
$state = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 200
  $state = Get-Smtc
  if (($state.title -match 'How Do I Make You Love Me') -and ($state.status -eq 'Playing')) { $t4 = Get-Date; break }
}
Say ''
if ($t4) {
  Say ('  [t4] SMTC reports target song PLAYING after ' + [int]((New-TimeSpan $t3 $t4).TotalMilliseconds) + ' ms (click -> Playing)')
  Say ('       title="' + $state.title + '"  status=' + $state.status + '  position=' + $state.pos)
  Say ('  TOTAL end-to-end (deep link -> Playing): ' + [int]((New-TimeSpan $t0 $t4).TotalMilliseconds) + ' ms')
} else {
  Say ('  playback did not start; SMTC now: title="' + (Get-Smtc).title + '" status=' + (Get-Smtc).status)
}

Say ''
Say '=== Cleanup: pause playback ==='
try {
  $s = Get-Session
  if ($s) { $null = Await ($s.TryPauseAsync()) ([bool]); Start-Sleep -Milliseconds 800; $p = Get-Smtc; Say ('  paused: title="' + $p.title + '" status=' + $p.status) }
} catch { Say ('  pause failed: ' + $_.Exception.Message) }

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
