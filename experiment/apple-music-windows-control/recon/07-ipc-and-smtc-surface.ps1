# ============================================================
# 07-ipc-and-smtc-surface.ps1   (reconnaissance, read-only)
#
# Part A: live IPC surface of the Apple Music package processes
#         (named pipes, TCP/UDP listeners, services, tasks, autostart).
# Part B: Windows SMTC (GlobalSystemMediaTransportControlsSession) capability surface:
#         the exact method list available to third-party apps, plus the live session snapshot.
#
# WinRT access technique mirrors MineRadio's existing desktop\smtc-bridge.ps1 (unchanged file).
# Safety: read-only. Only SMTC *read* calls are used; no control calls, no writes.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\07-ipc-and-smtc-surface.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$outFile = Join-Path $outDir '07-ipc-and-smtc-surface.txt'
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

Say '=== A1. Apple package processes ==='
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match 'AppleMusic|AMPLibraryAgent|SharedHelper|RestartAgent' -or ($_.ExecutablePath -and $_.ExecutablePath -match 'AppleMusicWin')
}
foreach ($p in $procs) { Say ('  pid=' + $p.ProcessId + '  ' + $p.Name + '  cmd=' + $p.CommandLine) }
if (-not $procs) { Say '  (no Apple Music package process running)' }
Say ''

Say '=== A2. TCP listeners / UDP endpoints per Apple pid ==='
foreach ($p in $procs) {
  $tcp = Get-NetTCPConnection -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue
  foreach ($c in $tcp) {
    Say ('  [TCP] pid=' + $p.ProcessId + ' ' + $p.Name + '  ' + $c.LocalAddress + ':' + $c.LocalPort + ' -> ' + $c.RemoteAddress + ':' + $c.RemotePort + '  state=' + $c.State)
  }
  $udp = Get-NetUDPEndpoint -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue
  foreach ($u in $udp) {
    Say ('  [UDP] pid=' + $p.ProcessId + ' ' + $p.Name + '  ' + $u.LocalAddress + ':' + $u.LocalPort)
  }
}
Say ''
Say '  all loopback listeners on this machine (pid + name):'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -match '127\.0\.0\.1|0\.0\.0\.0|::' } | Sort-Object LocalPort | ForEach-Object {
  $owner = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
  Say ('    ' + $_.LocalAddress + ':' + $_.LocalPort + '  pid=' + $_.OwningProcess + ' (' + $owner + ')')
}
Say ''

Say '=== A3. Named pipes: names matching apple/music/amp/media ==='
$pipes = [System.IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object { $_.Replace('\\.\pipe\', '') }
Say ('  total pipes: ' + $pipes.Count)
$interesting = $pipes | Where-Object { $_ -match 'apple|music|amp|media|itunes|daap|airplay' }
if ($interesting) { foreach ($i in $interesting) { Say ('    ' + $i) } } else { Say '    (none matching)' }
Say '  sample of all pipe names (first 40, for manual review):'
$pipes | Select-Object -First 40 | ForEach-Object { Say ('    ' + $_) }
Say ''

Say '=== A4. Services / scheduled tasks / autostart referencing Apple ==='
Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.PathName -match 'Apple' } | ForEach-Object {
  Say ('  [service] ' + $_.Name + '  state=' + $_.State + '  start=' + $_.StartMode + '  path=' + $_.PathName)
}
$taskHits = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'Apple|iTunes|Music' -or ($_.Actions.Execute -join ' ') -match 'Apple' }
foreach ($t in $taskHits) { Say ('  [task] ' + $t.TaskPath + $t.TaskName + '  ' + (($t.Actions | ForEach-Object { $_.Execute }) -join ';')) }
foreach ($runKey in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run')) {
  if (Test-Path $runKey) {
    $props = Get-ItemProperty -Path $runKey
    foreach ($v in $props.PSObject.Properties) {
      if ($v.Name -like 'PS*') { continue }
      if (('' + $v.Value) -match 'Apple|Music|iTunes') { Say ('  [run] ' + $runKey + '  ' + $v.Name + ' = ' + $v.Value) }
    }
  }
}
Say ''

Say '=== B1. SMTC type surface (what third-party apps can call) ==='
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType=WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo, Windows.Media.Control, ContentType=WindowsRuntime]
  Say '  WinRT Windows.Media.Control types loaded'
  foreach ($t in @([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager],
                   [Windows.Media.Control.GlobalSystemMediaTransportControlsSession])) {
    Say ('  --- ' + $t.FullName + ' ---')
    $t.GetMethods() | Where-Object { $_.DeclaringType -eq $t } | Sort-Object Name | ForEach-Object {
      $ps = ($_.GetParameters() | ForEach-Object { $_.ParameterType.Name }) -join ','
      Say ('      ' + $_.ReturnType.Name + ' ' + $_.Name + '(' + $ps + ')')
    }
    $t.GetProperties() | Where-Object { $_.DeclaringType -eq $t } | Sort-Object Name | ForEach-Object {
      Say ('      prop ' + $_.PropertyType.Name + ' ' + $_.Name)
    }
  }
  Say '  --- GlobalSystemMediaTransportControlsSessionMediaProperties (read-only snapshot fields) ---'
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties].GetProperties() | Sort-Object Name | ForEach-Object {
    Say ('      prop ' + $_.PropertyType.Name + ' ' + $_.Name)
  }
} catch {
  Say ('  WinRT load failed: ' + $_.Exception.Message)
}
Say ''

Say '=== B2. Live SMTC snapshot (read only) ==='
try {
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = $mgr.GetSessions()
  Say ('  sessions: ' + $sessions.Count)
  foreach ($s in $sessions) {
    Say ('  session sourceAppId = ' + $s.SourceAppUserModelId)
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($props) {
      Say ('      title=' + $props.Title + '  artist=' + $props.Artist + '  album=' + $props.AlbumTitle + '  trackNo=' + $props.TrackNumber)
    }
    $info = $s.GetPlaybackInfo()
    if ($info) { Say ('      status=' + $info.PlaybackStatus + '  rate=' + $info.PlaybackRate) }
    $tl = $s.GetTimelineProperties()
    if ($tl) { Say ('      position=' + $tl.Position + '  duration=' + $tl.EndTime) }
  }
} catch {
  Say ('  SMTC snapshot failed: ' + $_.Exception.Message)
}

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
