# ============================================================
# 09-poc-deeplink.ps1   (PoC: does any official URL/command-line path select a specific song?)
#
# Target song: How Do I Make You Love Me?  (song id 1603171530)
#   https://music.apple.com/cn/song/how-do-i-make-you-love-me/1603171530
#
# What it does for every candidate invocation:
#   - records the SMTC session snapshot BEFORE
#   - invokes the candidate (shell open of musics://, or AppleMusic.exe with the exact
#     command-line shape declared in the AppxManifest: /url "%1")
#   - waits, records SMTC AFTER, and saves a screenshot of the Apple Music window
#   - success criterion (per task definition): Apple Music actually plays THAT song
#     (SMTC title matches + playback status = Playing). Merely opening the app / a page is NOT success.
#
# Safety: no credentials, no DRM, no client modification. Only public activation + read-only
#         SMTC observation + screen capture of the app window.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\09-poc-deeplink.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$shotDir = Join-Path $outDir 'shots'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
$outFile = Join-Path $outDir '09-poc-deeplink.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

$SONG_ID = '1603171530'
$SONG_TITLE = 'How Do I Make You Love Me?'
$MUSICS_URL = 'musics://music.apple.com/cn/song/how-do-i-make-you-love-me/' + $SONG_ID
$HTTPS_URL = 'https://music.apple.com/cn/song/how-do-i-make-you-love-me/' + $SONG_ID

function Await($WinRtTask, [Type]$ResultType) {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(8000) | Out-Null
  return $netTask.Result
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class WinCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
try { Add-Type -TypeDefinition $sig -Language CSharp -ErrorAction Stop } catch { }

function Get-SmtcState {
  $state = @{ ok = $false; title = ''; artist = ''; album = ''; status = ''; position = ''; duration = ''; sourceApp = '' }
  try {
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $sessions = $mgr.GetSessions()
    $s = $null
    foreach ($cand in $sessions) {
      if (('' + $cand.SourceAppUserModelId) -match 'AppleMusic') { $s = $cand; break }
    }
    if (-not $s -and $sessions.Count -gt 0) { $s = $sessions[0] }
    if ($s) {
      $state.ok = $true
      $state.sourceApp = '' + $s.SourceAppUserModelId
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      if ($props) {
        $state.title = '' + $props.Title
        $state.artist = '' + $props.Artist
        $state.album = '' + $props.AlbumTitle
      }
      $info = $s.GetPlaybackInfo()
      if ($info) { $state.status = '' + $info.PlaybackStatus }
      $tl = $s.GetTimelineProperties()
      if ($tl) {
        $state.position = '' + $tl.Position
        $state.duration = '' + $tl.EndTime
      }
    }
  } catch {
    $state.title = 'SMTC read failed: ' + $_.Exception.Message
  }
  return $state
}

function Format-SmtcState($s, [string]$indent) {
  Say ($indent + 'smtc.ok=' + $s.ok + '  sourceApp=' + $s.sourceApp)
  Say ($indent + 'title="' + $s.title + '"  artist="' + $s.artist + '"  album="' + $s.album + '"')
  Say ($indent + 'status=' + $s.status + '  position=' + $s.position + ' / ' + $s.duration)
}

function Save-Shot([string]$name) {
  $p = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq 0) { Say ('  (no window to capture)'); return }
  try {
    [WinCap]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
    [WinCap]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 700
    $r = New-Object WinCap+RECT
    [WinCap]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { Say '  (window rect invalid)'; return }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $path = Join-Path $shotDir $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Say ('  screenshot saved: ' + $path)
  } catch {
    Say ('  screenshot failed: ' + $_.Exception.Message)
  }
}

function Get-AppleMusicExe {
  $loc = (Get-AppxPackage -Name 'AppleInc.AppleMusicWin').InstallLocation
  return (Join-Path $loc 'AppleMusic.exe')
}

Say ('=== PoC target: ' + $SONG_TITLE + '  (id ' + $SONG_ID + ') ===')
Say ('  musics url: ' + $MUSICS_URL)
Say ('  https  url: ' + $HTTPS_URL)
Say ''

Say '=== 0. baseline ==='
$base = Get-SmtcState
Format-SmtcState $base '  '
Save-Shot '09-00-baseline.png'
Say ''

$exe = Get-AppleMusicExe
Say ('  AppleMusic.exe = ' + $exe)

$tests = @(
  @{ name = '01-shell-musics'; launch = 'shell'; target = $MUSICS_URL;  desc = 'ShellExecute musics://song/.../1603171530 (what the user tested)' },
  @{ name = '02-exe-url-musics'; launch = 'exe'; target = '/url "' + $MUSICS_URL + '"'; desc = 'AppleMusic.exe /url "musics://..." (exact manifest shape)' },
  @{ name = '03-exe-url-https'; launch = 'exe'; target = '/url "' + $HTTPS_URL + '"'; desc = 'AppleMusic.exe /url "https://music.apple.com/..."' },
  @{ name = '04-shell-https'; launch = 'shell'; target = $HTTPS_URL; desc = 'ShellExecute https://music.apple.com/... (default browser?)' }
)

foreach ($t in $tests) {
  Say ('=== TEST ' + $t.name + ' ===')
  Say ('  what : ' + $t.desc)
  Say ('  inv  : ' + $t.target)
  $before = Get-SmtcState
  Say '  before:'
  Format-SmtcState $before '    '
  try {
    if ($t.launch -eq 'shell') {
      Start-Process $t.target | Out-Null
    } else {
      Start-Process -FilePath $exe -ArgumentList $t.target | Out-Null
    }
  } catch {
    Say ('  launch failed: ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds 10
  $after = Get-SmtcState
  Say '  after (10s):'
  Format-SmtcState $after '    '
  $playedTarget = ($after.title -match [regex]::Escape(($SONG_TITLE -replace '\?$', ''))) -and ($after.status -eq 'Playing')
  Say ('  RESULT: song selected AND playing = ' + $playedTarget)
  Save-Shot ('09-' + $t.name + '.png')
  Say ''
}

Say '=== Summary ==='
Say '  success criterion: SMTC title matches the target song AND status = Playing'
Say '  note: "opened the app" / "showed a page" is NOT success by the task definition.'

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
