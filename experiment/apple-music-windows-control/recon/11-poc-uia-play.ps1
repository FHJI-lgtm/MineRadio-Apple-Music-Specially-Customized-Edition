# ============================================================
# 11-poc-uia-play.ps1   (PoC: precise song playback through UI Automation)
#
# Target: How Do I Make You Love Me?  (song id 1603171530) - currently listed in the visible
#         Apple Music album page (Dawn FM) as: ListItem "音轨 3 How Do I Make You Love Me? ..."
#
# Flow:
#   1. read SMTC before
#   2. find the ListItem whose Name contains the song title (official UIA API)
#   3. try, in order: SelectionItemPattern.Select -> InvokePattern.Invoke -> double click at
#      the element's clickable point -> Enter key
#   4. read SMTC after: success = title matches AND PlaybackStatus = Playing
#   5. capture a window screenshot as evidence; then pause playback (cleanup) and report
#
# Safety: only official UI Automation + official SMTC control (pause) on the user's own app.
#         No injection, no client modification, no credentials, no DRM work.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\11-poc-uia-play.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$shotDir = Join-Path $outDir 'shots'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
$outFile = Join-Path $outDir '11-poc-uia-play.txt'
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
public static class Cap2 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
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
    foreach ($s in $mgr.GetSessions()) {
      if (('' + $s.SourceAppUserModelId) -match 'AppleMusic') { return $s }
    }
  } catch { }
  return $null
}

function Get-Smtc {
  $out = @{ title = ''; artist = ''; album = ''; status = ''; pos = ''; dur = '' }
  $s = Get-Session
  if (-not $s) { return $out }
  try {
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($p) { $out.title = '' + $p.Title; $out.artist = '' + $p.Artist; $out.album = '' + $p.AlbumTitle }
    $i = $s.GetPlaybackInfo()
    if ($i) { $out.status = '' + $i.PlaybackStatus }
    $t = $s.GetTimelineProperties()
    if ($t) { $out.pos = '' + $t.Position; $out.dur = '' + $t.EndTime }
  } catch { }
  return $out
}

function Show-Smtc($s, [string]$tag) {
  Say ('  [' + $tag + '] title="' + $s.title + '" artist="' + $s.artist + '" album="' + $s.album + '" status=' + $s.status + ' pos=' + $s.pos + '/' + $s.dur)
}

function Save-Shot([string]$name) {
  $p = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq 0) { Say '  (no window)'; return }
  [Cap2]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
  [Cap2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 600
  $r = New-Object Cap2+RECT
  [Cap2]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { Say '  (bad rect)'; return }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [Cap2]::PrintWindow($p.MainWindowHandle, $hdc, 2)
  $g.ReleaseHdc($hdc)
  if (-not $ok) {
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
    Say '  (PrintWindow failed, used CopyFromScreen)'
  } else {
    Say '  (PrintWindow)'
  }
  $path = Join-Path $shotDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Say ('  screenshot: ' + $path)
}

$proc = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue
if (-not $proc) { Say 'AppleMusic not running'; exit 1 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $root) { Say 'no root element'; exit 1 }

Say '=== PoC: precise song playback via UI Automation ==='
Say ('  target title: ' + $TITLE)
$before = Get-Smtc
Show-Smtc $before 'before'

Say ''
Say '=== A. locate the track row ==='
$listCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
$items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)
Say ('  ListItems visible: ' + $items.Count)
$target = $null
for ($i = 0; $i -lt $items.Count; $i++) {
  $it = $items.Item($i)
  $n = '' + $it.Current.Name
  if ($n -match [regex]::Escape($TITLE)) { $target = $it; break }
  if ($n -match 'How Do I Make You Love Me') { $target = $it; break }
}
if (-not $target) {
  Say '  target row NOT found in the current view -> cannot run the click PoC'
  Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
  exit 2
}
Say ('  found: "' + $target.Current.Name + '"')
Say ('    patterns: ' + (($target.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ', '))
$r = $target.Current.BoundingRectangle
Say ('    bounding rect: ' + $r.ToString())
$clickX = [int]($r.Left + $r.Width * 0.35)
$clickY = [int]($r.Top + $r.Height / 2)

Say ''
Say '=== B. attempt 1: SelectionItemPattern.Select ==='
$played = $false
try {
  $si = $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $si.Select()
  Say '  Select() issued'
} catch { Say ('  Select() failed: ' + $_.Exception.Message) }
Start-Sleep -Seconds 3
$s1 = Get-Smtc
Show-Smtc $s1 'after Select'
if ($s1.title -match 'How Do I Make You Love Me' -and $s1.status -eq 'Playing') { $played = $true }

if (-not $played) {
  Say ''
  Say '=== C. attempt 2: double click on the row (mouse input) ==='
  try {
    $target.SetFocus()
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point $clickX, $clickY
    Start-Sleep -Milliseconds 200
    Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);' -Name M -Namespace P -ErrorAction SilentlyContinue
    [P.M]::mouse_event(2, 0, 0, 0, 0)   # LEFTDOWN
    [P.M]::mouse_event(4, 0, 0, 0, 0)   # LEFTUP
    Start-Sleep -Milliseconds 120
    [P.M]::mouse_event(2, 0, 0, 0, 0)
    [P.M]::mouse_event(4, 0, 0, 0, 0)
    Say ('  double click at ' + $clickX + ',' + $clickY)
  } catch { Say ('  double click failed: ' + $_.Exception.Message) }
  Start-Sleep -Seconds 4
  $s2 = Get-Smtc
  Show-Smtc $s2 'after double click'
  if ($s2.title -match 'How Do I Make You Love Me' -and $s2.status -eq 'Playing') { $played = $true }
}

if (-not $played) {
  Say ''
  Say '=== D. attempt 3: InvokePattern.Invoke ==='
  try {
    $inv = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $inv.Invoke()
    Say '  Invoke() issued'
  } catch { Say ('  Invoke() not supported / failed: ' + $_.Exception.Message) }
  Start-Sleep -Seconds 4
  $s3 = Get-Smtc
  Show-Smtc $s3 'after Invoke'
  if ($s3.title -match 'How Do I Make You Love Me' -and $s3.status -eq 'Playing') { $played = $true }
}

Say ''
Say '=== E. final state ==='
$after = Get-Smtc
Show-Smtc $after 'final'
Save-Shot '11-poc-uia-play.png'
Say ''
Say ('  RESULT: precise playback of the target song = ' + $played)
Say '  (success requires SMTC title match AND PlaybackStatus = Playing)'

Say ''
Say '=== F. cleanup: pause playback via official SMTC API (leave the app quiet) ==='
try {
  $s = Get-Session
  if ($s -and $played) {
    $null = Await ($s.TryPauseAsync()) ([bool])
    Start-Sleep -Seconds 1
    $paused = Get-Smtc
    Show-Smtc $paused 'after pause'
    Say '  paused (song stays selected)'
  } else {
    Say '  nothing to pause'
  }
} catch { Say ('  pause failed: ' + $_.Exception.Message) }

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
