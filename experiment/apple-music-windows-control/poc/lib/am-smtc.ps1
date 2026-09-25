# ============================================================
# poc/lib/am-smtc.ps1
# SMTC (System Media Transport Controls) access: the ONLY source of truth for
# "did the song actually start playing".
#
# Ported from recon/12-poc-uia-play-v2.ps1 (Get-Session / Get-Smtc / Await) and
# recon/13-latency-and-search.ps1 (polling + timing), with the classification
# rules required by the experiment:
#
#   * Playing + wrong track   -> SMTC_WRONG_TRACK   (the click played something else,
#                                                    or Apple Music switched elsewhere)
#   * never reached Playing   -> SMTC_TIMEOUT       (the click did not start playback)
#
# Both are recorded with the raw observations so a later analysis can tell a UI
# click failure apart from a track-switch delay / state race.
#
# ASCII-only on purpose.
# ============================================================

Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]

function Await-AmWinRt($WinRtTask, [Type]$ResultType) {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(8000) | Out-Null
  return $netTask.Result
}

function Get-AmSession {
  try {
    $mgr = Await-AmWinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    foreach ($s in $mgr.GetSessions()) {
      if (('' + $s.SourceAppUserModelId) -match 'AppleMusic') { return $s }
    }
  } catch { }
  return $null
}

# Full read-only snapshot of the Apple Music SMTC session.
function Get-AmSmtcState {
  $out = @{ ok = $false; title = ''; artist = ''; album = ''; status = ''; pos = ''; dur = ''; posMs = 0; aumid = '' }
  $s = Get-AmSession
  if (-not $s) { return $out }
  try {
    $out.aumid = '' + $s.SourceAppUserModelId
    $p = Await-AmWinRt ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($p) { $out.title = '' + $p.Title; $out.artist = '' + $p.Artist; $out.album = '' + $p.AlbumTitle }
    $i = $s.GetPlaybackInfo()
    if ($i) { $out.status = '' + $i.PlaybackStatus }
    $t = $s.GetTimelineProperties()
    if ($t) { $out.pos = '' + $t.Position; $out.dur = '' + $t.EndTime; $out.posMs = [int64]$t.Position.TotalMilliseconds }
    $out.ok = $true
  } catch { }
  return $out
}

function Get-AmPlaybackStatus { return (Get-AmSmtcState).status }

# Pause through SMTC. Used by the test harness before every attempt so that a
# previous attempt cannot be mistaken for a fresh successful play.
function Invoke-AmPause {
  try {
    $s = Get-AmSession
    if (-not $s) { return $false }
    $null = Await-AmWinRt ($s.TryPauseAsync()) ([bool])
    return $true
  } catch { return $false }
}

# Wait until the session is no longer Playing (short settle window), so that the
# attempt can start from a known baseline.
function Wait-AmSmtcSettled([int]$TimeoutMs = 1500, [int]$PollMs = 100) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $last = $null
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    $last = Get-AmSmtcState
    if ($last.status -ne 'Playing') { break }
    Start-Sleep -Milliseconds $PollMs
  }
  return @{ settled = ($last -and $last.status -ne 'Playing'); waitedMs = [int]$sw.ElapsedMilliseconds; state = $last }
}

# Poll SMTC until the wanted song is Playing.
#   result: MATCH | WRONG_TRACK | TIMEOUT   (see the classification rules above)
function Wait-AmPlayback([string]$Title, [string]$Artist, [int]$TimeoutMs = 6000, [int]$PollMs = 120) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $sawPlaying = $false
  $sawPlayingWrong = $false
  $wrongTitles = New-Object System.Collections.Generic.List[string]
  $statuses = New-Object System.Collections.Generic.List[string]
  $firstWrongMs = $null
  $match = $null
  $last = $null

  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    $last = Get-AmSmtcState
    if ($last.status -and -not $statuses.Contains($last.status)) { $statuses.Add($last.status) }
    if ($last.status -eq 'Playing') {
      $sawPlaying = $true
      $titleOk = Test-AmSmtcTitleMatch $last.title $Title
      $artistOk = Test-AmSmtcArtistMatch $last.artist $Artist
      if ($titleOk -and $artistOk) { $match = $last; break }
      $sawPlayingWrong = $true
      if ($null -eq $firstWrongMs) { $firstWrongMs = [int]$sw.ElapsedMilliseconds }
      $t = ('' + $last.title)
      if ($t -and -not $wrongTitles.Contains($t)) { $wrongTitles.Add($t) }
    }
    Start-Sleep -Milliseconds $PollMs
  }

  $elapsed = [int]$sw.ElapsedMilliseconds
  if ($match) {
    return @{
      result = 'MATCH'; elapsedMs = $elapsed; title = $match.title; artist = $match.artist
      status = $match.status; pos = $match.pos; posMs = $match.posMs
      sawPlaying = $true; sawPlayingWrong = $false; firstWrongMs = $null
      wrongTitles = @(); statuses = @($statuses); hasSession = $true
    }
  }

  $final = Get-AmSmtcState
  $finalIsWrongPlaying = ($final.status -eq 'Playing')
  $result = 'TIMEOUT'
  if ($finalIsWrongPlaying -or $sawPlayingWrong) { $result = 'WRONG_TRACK' }
  return @{
    result = $result; elapsedMs = $elapsed; title = $final.title; artist = $final.artist
    status = $final.status; pos = $final.pos; posMs = $final.posMs
    sawPlaying = $sawPlaying; sawPlayingWrong = $sawPlayingWrong; firstWrongMs = $firstWrongMs
    wrongTitles = @($wrongTitles); statuses = @($statuses); hasSession = $final.ok
  }
}
