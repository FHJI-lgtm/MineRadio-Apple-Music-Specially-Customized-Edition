# ============================================================
# 08-launch-and-window-stack.ps1   (reconnaissance; launches Apple Music on purpose)
#
# Purpose:
#   1. start Apple Music (AppleMusic.exe via its AppExecutionAlias) - the app is the subject
#      of this experiment and must be running for UI Automation / IPC observation
#   2. observe the window class / process tree (tells us which UI stack the app uses:
#      WinUI3 / WebView2 / Qt / custom)
#   3. re-run the IPC observation with the app running (named pipes, per-pid endpoints)
#   4. read the live SMTC session snapshot (read-only)
#
# Safety: no credentials, no DRM, no client modification. Only starting the user's own app and
#         observing public OS state.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\08-launch-and-window-stack.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$outFile = Join-Path $outDir '08-launch-and-window-stack.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

function Await($WinRtTask, [Type]$ResultType) {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(8000) | Out-Null
  return $netTask.Result
}

Say '=== A. Launch Apple Music (if not running) ==='
$existing = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue
if ($existing) {
  Say ('  already running: pid=' + ($existing | ForEach-Object { $_.Id }))
} else {
  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\AppleMusic.exe'
  Say ('  launching: ' + $alias)
  try {
    Start-Process -FilePath $alias | Out-Null
    Say '  Start-Process returned'
  } catch {
    Say ('  launch failed: ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds 12
}
Say ''
Say '  processes after launch:'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match 'AppleMusic|AMPLibraryAgent|SharedHelper|RestartAgent|AppleMusic_Helper'
} | ForEach-Object { Say ('    pid=' + $_.ProcessId + '  ' + $_.Name) }

Say ''
Say '=== B. Top level windows of AppleMusic.exe (class name = UI stack hint) ==='
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32Info {
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static string ClassOf(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static string TextOf(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
'@
try { Add-Type -TypeDefinition $sig -Language CSharp -ErrorAction Stop } catch { }

$applePids = (Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  if ($applePids -notcontains $p.Id) { continue }
  Say ('  pid=' + $p.Id + '  MainWindowHandle=' + $p.MainWindowHandle + '  title=' + $p.MainWindowTitle)
  if ($p.MainWindowHandle -ne 0) {
    Say ('    window class = ' + [Win32Info]::ClassOf($p.MainWindowHandle))
  }
}
Say ''
Say '  child processes of AppleMusic.exe:'
$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
foreach ($a in $applePids) {
  $children = $all | Where-Object { $_.ParentProcessId -eq $a }
  foreach ($c in $children) {
    Say ('    child pid=' + $c.ProcessId + '  ' + $c.Name + '  cmd=' + ('' + $c.CommandLine).Substring(0, [Math]::Min(220, ('' + $c.CommandLine).Length)))
  }
}

Say ''
Say '=== C. Named pipes named apple/music/amp/media (app running) ==='
$pipes = [System.IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object { $_.Replace('\\.\pipe\', '') }
Say ('  total pipes: ' + $pipes.Count)
$hits = $pipes | Where-Object { $_ -match 'apple|music|itunes|daap|airplay' }
if ($hits) { foreach ($h in $hits) { Say ('    [HIT] ' + $h) } } else { Say '    no apple/music/itunes/daap/airplay named pipes' }

Say ''
Say '=== D. Endpoints owned by Apple pids (listen state first) ==='
$applePids2 = ((Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'AppleMusic|AMPLibraryAgent' }).ProcessId)
foreach ($pid2 in $applePids2) {
  $listen = Get-NetTCPConnection -State Listen -OwningProcess $pid2 -ErrorAction SilentlyContinue
  if ($listen) {
    foreach ($l in $listen) { Say ('    [LISTEN] pid=' + $pid2 + '  ' + $l.LocalAddress + ':' + $l.LocalPort) }
  } else {
    Say ('    pid=' + $pid2 + ': no TCP listener')
  }
  $udp = Get-NetUDPEndpoint -OwningProcess $pid2 -ErrorAction SilentlyContinue
  foreach ($u in $udp) { Say ('    [UDP-BOUND] pid=' + $pid2 + '  ' + $u.LocalAddress + ':' + $u.LocalPort) }
}

Say ''
Say '=== E. Live SMTC snapshot while Apple Music runs (read-only) ==='
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = $mgr.GetSessions()
  Say ('  sessions: ' + $sessions.Count)
  foreach ($s in $sessions) {
    Say ('  sourceAppId = ' + $s.SourceAppUserModelId)
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($props) { Say ('      title=' + $props.Title + ' | artist=' + $props.Artist + ' | album=' + $props.AlbumTitle) }
    $info = $s.GetPlaybackInfo()
    if ($info) { Say ('      status=' + $info.PlaybackStatus) }
    $tl = $s.GetTimelineProperties()
    if ($tl) { Say ('      position=' + $tl.Position + ' / ' + $tl.EndTime) }
  }
  if ($sessions.Count -eq 0) { Say '  (no media session yet - Apple Music may need to start playback once)' }
} catch {
  Say ('  SMTC read failed: ' + $_.Exception.Message)
}

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
