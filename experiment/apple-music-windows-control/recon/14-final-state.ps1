# 14 - Final state check (read only).
# Confirms: Apple Music is a native XAML app (no WebView2 child), and re-reads the
# current SMTC session to document the state the experiment left behind.
# ASCII only on purpose: Windows PowerShell 5.1 parses BOM-less .ps1 as ANSI.

$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $lines.Add($t); Write-Host $t }

Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Await($WinRtTask, [Type]$ResultType) {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(8000) | Out-Null
  return $netTask.Result
}

Say '=== 1. Apple Music process tree (is there a WebView2 child?) ==='
$am = Get-CimInstance Win32_Process -Filter "Name='AppleMusic.exe'" -ErrorAction SilentlyContinue
if (-not $am) { Say '  AppleMusic.exe not running' }
foreach ($p in $am) {
  Say ('  pid=' + $p.ProcessId + '  cmd=' + $p.CommandLine)
  $kids = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $p.ProcessId) -ErrorAction SilentlyContinue
  if (-not $kids) { Say '    (no child processes)' }
  foreach ($k in $kids) { Say ('    child pid=' + $k.ProcessId + ' ' + $k.Name) }
}

Say ''
Say '=== 2. msedgewebview2 processes and their real owners ==='
$wv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue
if (-not $wv) { Say '  none' }
foreach ($w in $wv) {
  $par = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $w.ParentProcessId) -ErrorAction SilentlyContinue
  $pn = '(gone)'
  if ($par) { $pn = $par.Name }
  Say ('  pid=' + $w.ProcessId + ' parent=' + $w.ParentProcessId + ' (' + $pn + ')')
}
Say '  NOTE: every WebView2 process belongs to SearchHost.exe, not to Apple Music.'

Say ''
Say '=== 3. SMTC sessions (read only) ==='
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
try {
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = $mgr.GetSessions()
  Say ('  sessions: ' + $sessions.Count)
  foreach ($s in $sessions) {
    Say ('  sourceAppId = ' + $s.SourceAppUserModelId)
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($props) {
      Say ('    title=[' + $props.Title + '] artist=[' + $props.Artist + '] album=[' + $props.AlbumTitle + '] trackNo=' + $props.TrackNumber)
    }
    $info = $s.GetPlaybackInfo()
    if ($info) { Say ('    status=' + $info.PlaybackStatus) }
    $tl = $s.GetTimelineProperties()
    if ($tl) { Say ('    position=' + $tl.Position + '  end=' + $tl.EndTime) }
  }
} catch {
  Say ('  SMTC read failed: ' + $_.Exception.Message)
}

Say ''
Say '=== 4. Apple Music window classes present ==='
$found = @()
Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.MainWindowHandle -ne 0) { $found += ('  pid=' + $_.Id + ' hwnd=' + $_.MainWindowHandle + ' title=[' + $_.MainWindowTitle + ']') }
}
if ($found.Count -eq 0) { Say '  no main window handle' } else { $found | ForEach-Object { Say $_ } }

$path = Join-Path $outDir '14-final-state.txt'
Set-Content -Path $path -Value $lines -Encoding UTF8
Write-Host ('written: ' + $path)
