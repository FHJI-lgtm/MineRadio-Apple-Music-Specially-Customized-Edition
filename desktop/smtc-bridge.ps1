# smtc-bridge.ps1
# ------------------------------------------------------------------
# Windows SMTC -> JSON-lines bridge for Mineradio (v2, event-driven).
#
# PROTOCOL (strict):
#   stdout : ONLY compact JSON lines: {"type":"state"|"ready"|"error",...}
#   stderr : [SMTC][<ms>] debug log lines (never mixed into stdout)
#
# PS 5.1 NOTE: add_Event({}) handlers NEVER fire inside a running
# script; we therefore use Register-ObjectEvent whose -Action runs in
# a background runspace and fires immediately. All state/functions
# shared with those actions live in $global: scope. A 150ms throttle
# dedupes burst events (Media/Playback/Timeline fire together).
#
# Run standalone:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\desktop\smtc-bridge.ps1
# ------------------------------------------------------------------
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$global:SmtcManager = $null
$global:SmtcSession = $null
$global:SmtcLastEmitMs = 0
$global:SmtcThrottleMs = 150
$global:SmtcThumbKey = ''      # 上次读取封面的歌曲 identity (防重复传输)
$global:SmtcThumbDataUrl = $null

function global:NowMs() {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function global:Log([string]$msg) {
  try {
    [Console]::Error.WriteLine('[SMTC][' + (global:NowMs) + '] ' + $msg)
    [Console]::Error.Flush()
  } catch { }
}

function global:Await($WinRtTask, [Type]$ResultType) {
  try {
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    if ($null -eq $asTaskGeneric) {
      global:Log 'Await: AsTask(IAsyncOperation<T>) reflection failed'
      return $null
    }
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    if ($null -eq $netTask) { return $null }
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
  } catch {
    global:Log ('Await failed: ' + $_.Exception.Message)
    return $null
  }
}

# ---- Phase 4A: album cover (Thumbnail -> base64 data URL) ----
# 只在歌曲 identity 变化时读取; 切歌瞬间封面可能还在加载 -> 重试 2~3 次。
# 任何失败返回 $null (绝不崩溃), 前端 fallback 到默认封面。

function global:ReadThumbnailDataUrl($props) {
  # PS 5.1 无法投影 WinRT 流接口(__ComObject), 此处尝试后优雅返回 null;
  # 前端 fallback 到默认封面。任何失败绝不崩溃。
  try {
    if ($null -eq $props -or $null -eq $props.Thumbnail) { return $null }
    $stream = global:Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $stream) { return $null }
    $contentType = ''
    try { $contentType = [string]$stream.ContentType } catch { }
    $netStream = $null
    try {
      $ir = [Windows.Storage.Streams.IRandomAccessStream]$stream
      $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($ir)
    } catch { }
    if ($null -eq $netStream) { return $null }
    $ms = New-Object System.IO.MemoryStream
    $netStream.CopyTo($ms)
    $bytes = $ms.ToArray()
    if ($bytes.Length -lt 4 -or $bytes.Length -gt 5242880) { return $null }
    if ([string]::IsNullOrEmpty($contentType)) {
      $contentType = 'image/jpeg'
      if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) { $contentType = 'image/png' }
      elseif ($bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x46 -and $bytes[3] -eq 0x46) { $contentType = 'image/webp' }
    }
    return ('data:' + $contentType + ';base64,' + [Convert]::ToBase64String($bytes))
  } catch {
    global:Log ('ReadThumbnailDataUrl failed: ' + $_.Exception.Message)
    return $null
  }
}

function global:ReadThumbnailWithRetry($props) {
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    if ($attempt -gt 0) { Start-Sleep -Milliseconds 350 }
    $t = global:ReadThumbnailDataUrl $props
    if ($null -ne $t) { return $t }
  }
  return $null
}

function global:SubscribeSession($session) {
  if ($null -eq $session) { return }
  # 清理指向其它/旧 session 的订阅，避免无限累积
  Get-EventSubscriber -ErrorAction SilentlyContinue |
    Where-Object { $null -ne $_.SourceObject -and $_.SourceObject -ne $session } |
    Unregister-Event -ErrorAction SilentlyContinue
  $names = @(Get-EventSubscriber -ErrorAction SilentlyContinue | Where-Object { $_.SourceObject -eq $session } | ForEach-Object { $_.EventName })
  if ($names -notcontains 'MediaPropertiesChanged') {
    Register-ObjectEvent -InputObject $session -EventName MediaPropertiesChanged -Action { global:EmitState $Event } | Out-Null
    global:Log 'MediaPropertiesChanged subscribed'
  }
  if ($names -notcontains 'PlaybackInfoChanged') {
    Register-ObjectEvent -InputObject $session -EventName PlaybackInfoChanged -Action { global:EmitState $Event } | Out-Null
    global:Log 'PlaybackInfoChanged subscribed'
  }
  if ($names -notcontains 'TimelinePropertiesChanged') {
    Register-ObjectEvent -InputObject $session -EventName TimelinePropertiesChanged -Action { global:EmitState $Event } | Out-Null
    global:Log 'TimelinePropertiesChanged subscribed'
  }
}

function global:SyncSession {
  try {
    $s = $global:SmtcManager.GetCurrentSession()
    if ($s -ne $global:SmtcSession) {
      $global:SmtcSession = $s
      if ($null -eq $s) {
        global:Log 'No active media session'
      } else {
        global:Log 'Session found'
        global:SubscribeSession $s
      }
    }
  } catch {
    global:Log ('SyncSession error: ' + $_.Exception.Message)
  }
}

function global:EmitState([object]$eventInfo) {
  try {
    $now = global:NowMs
    if (($now - $global:SmtcLastEmitMs) -lt $global:SmtcThrottleMs) { return }
    $global:SmtcLastEmitMs = $now

    $evName = 'poll'
    if ($null -ne $eventInfo) {
      try { $evName = [string]$eventInfo.EventName } catch { $evName = 'event' }
    }
    global:Log ('event=' + $evName + ' (T0)')

    global:SyncSession
    $s = $global:SmtcSession
    if ($null -eq $s) {
      [Console]::Out.WriteLine('{"type":"state","active":false}')
      [Console]::Out.Flush()
      return
    }

    $snap = @{ type = 'state'; active = $true; title = ''; artist = ''; album = ''; status = ''; isPlaying = $false; durationMs = 0; positionMs = 0; lastUpdatedMs = 0; aumid = '' }
    try { $snap.aumid = [string]$s.SourceAppUserModelId } catch { }
    try {
      $props = global:Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      if ($null -ne $props) {
        $snap.title = [string]$props.Title
        $snap.artist = [string]$props.Artist
        $snap.album = [string]$props.Album
        global:Log ('(T1) TITLE=' + $snap.title + ' ARTIST=' + $snap.artist + ' ALBUM=' + $snap.album)
        # Phase 4A: 歌曲 identity 变化 -> 读封面 (防抖重试, 失败=null)
        $identityKey = $snap.aumid + '|' + $snap.title + '|' + $snap.artist + '|' + $snap.album
        if ($identityKey -ne $global:SmtcThumbKey) {
          $global:SmtcThumbKey = $identityKey
          $thumb = global:ReadThumbnailWithRetry $props
          $global:SmtcThumbDataUrl = $thumb
          if ($null -eq $thumb) {
            $snap.thumbnail = $null   # 显式 null: 前端清除旧封面
            global:Log '(THUMB) identity changed, thumbnail=null'
          } else {
            $snap.thumbnail = $thumb
            global:Log ('(THUMB) identity changed, thumbnail len=' + $thumb.Length)
          }
        }
      }
    } catch {
      global:Log ('TryGetMediaPropertiesAsync failed: ' + $_.Exception.Message)
    }
    try {
      $playback = $s.GetPlaybackInfo()
      if ($null -ne $playback) {
        $snap.status = [string]$playback.PlaybackStatus
        $snap.isPlaying = ($playback.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing)
        global:Log ('PLAYBACK=' + $snap.status)
      }
    } catch {
      global:Log ('GetPlaybackInfo failed: ' + $_.Exception.Message)
    }
    try {
      $timeline = $s.GetTimelineProperties()
      if ($null -ne $timeline) {
        $snap.durationMs = [int64]$timeline.EndTime.TotalMilliseconds
        $snap.positionMs = [int64]$timeline.Position.TotalMilliseconds
        $snap.lastUpdatedMs = [int64]([DateTimeOffset]$timeline.LastUpdatedTime).ToUnixTimeMilliseconds()
        global:Log ('POSITION=' + $snap.positionMs + ' DURATION=' + $snap.durationMs)
      }
    } catch {
      global:Log ('GetTimelineProperties failed: ' + $_.Exception.Message)
    }

    $json = $snap | ConvertTo-Json -Compress -Depth 6
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    global:Log ('(T2) JSON emitted')
  } catch {
    global:Log ('EmitState error: ' + $_.Exception.Message)
  }
}

# --- Phase 4B: SMTC 播放控制 (stdin JSON 命令入口) ---
# 协议:
#   stdin : {"command":"play"|"pause"|"toggle"|"next"|"previous"}
#   stdout: {"type":"control-result","command":"...","success":true[, "error":"..."]}
# 控制目标 = 当前 active GlobalSystemMediaTransportControlsSession
# (与音频采集的 AMPLibraryAgent PID 完全无关, 两条链路独立)

function global:EmitControlResult([string]$cmd, [bool]$success, [string]$err) {
  $out = @{ type = 'control-result'; command = $cmd; success = $success }
  if (-not [string]::IsNullOrEmpty($err)) { $out.error = $err }
  try {
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
  } catch { }
  global:Log ('control ' + $cmd + ' success=' + $success)
}

function global:HandleControlCommand([string]$command) {
  try {
    global:SyncSession
    $s = $global:SmtcSession
    if ($null -eq $s) {
      global:EmitControlResult $command $false 'no active session'
      return
    }
    switch ($command) {
      'play' {
        $ok = global:Await ($s.TryPlayAsync()) ([bool])
        global:EmitControlResult 'play' ($ok -eq $true) $null
      }
      'pause' {
        $ok = global:Await ($s.TryPauseAsync()) ([bool])
        global:EmitControlResult 'pause' ($ok -eq $true) $null
      }
      'toggle' {
        # 按 PlaybackInfo.PlaybackStatus 判断: Playing -> Pause, 否则 -> Play
        $status = 'Paused'
        try { $status = [string]$s.GetPlaybackInfo().PlaybackStatus } catch { }
        if ($status -eq 'Playing') {
          $ok = global:Await ($s.TryPauseAsync()) ([bool])
          global:EmitControlResult 'toggle' ($ok -eq $true) $null
        } else {
          $ok = global:Await ($s.TryPlayAsync()) ([bool])
          global:EmitControlResult 'toggle' ($ok -eq $true) $null
        }
      }
      'next' {
        $ok = global:Await ($s.TrySkipNextAsync()) ([bool])
        global:EmitControlResult 'next' ($ok -eq $true) $null
      }
      'previous' {
        $ok = global:Await ($s.TrySkipPreviousAsync()) ([bool])
        global:EmitControlResult 'previous' ($ok -eq $true) $null
      }
      default {
        global:EmitControlResult $command $false 'unknown command'
      }
    }
  } catch {
    global:EmitControlResult $command $false ($_.Exception.Message)
  }
}

# --- 初始化（主 runspace） ---
global:Log ('Bridge started | PowerShell ' + $PSVersionTable.PSVersion.ToString() + ' | OS ' + [System.Environment]::OSVersion.VersionString)

$loaded = $false
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  global:Log 'System.Runtime.WindowsRuntime assembly loaded'
  $loaded = $true
} catch {
  global:Log ('Add-Type failed: ' + $_.Exception.Message)
}

if ($loaded) {
  try {
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
    global:Log 'Windows.Media.Control types loaded'
  } catch {
    global:Log ('WinRT type load failed: ' + $_.Exception.Message)
    $loaded = $false
  }
}

if ($loaded) {
  try {
    $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [System.IO.WindowsRuntimeStreamExtensions]
    global:Log 'Windows.Storage.Streams types loaded'
  } catch {
    global:Log ('Streams type load failed: ' + $_.Exception.Message)
  }
}

if ($loaded) {
  try {
    $global:SmtcManager = global:Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    if ($null -eq $global:SmtcManager) {
      global:Log 'Session manager initialization returned null'
    } else {
      global:Log 'Session manager initialized'
    }
  } catch {
    global:Log ('Session manager init failed: ' + $_.Exception.Message)
    $global:SmtcManager = $null
  }
}

if ($null -ne $global:SmtcManager) {
  Register-ObjectEvent -InputObject $global:SmtcManager -EventName SessionsChanged -Action { global:EmitState $Event } | Out-Null
  global:Log 'SessionsChanged subscribed'

  global:SyncSession
  global:SubscribeSession $global:SmtcSession

  # 5s 低频 fallback：仅防事件丢失，不承担主更新职责
  $global:SmtcPollTimer = New-Object System.Timers.Timer
  $global:SmtcPollTimer.Interval = 5000
  $global:SmtcPollTimer.AutoReset = $true
  Register-ObjectEvent -InputObject $global:SmtcPollTimer -EventName Elapsed -Action { global:EmitState $null } | Out-Null
  $global:SmtcPollTimer.Start()
  global:Log 'Fallback poll timer started (5000ms)'

  # 初始快照
  global:EmitState $null
} else {
  global:Log 'SMTC manager unavailable'
}

[Console]::Out.WriteLine('{"type":"ready"}')
[Console]::Out.Flush()
global:Log 'Bridge ready'

# 保活 + Phase 4B: stdin JSON 控制命令入口
# Register-ObjectEvent 的 Action 在后台 runspace 执行, 主 runspace 阻塞在
# [Console]::In.ReadLine() 等待控制命令 (不会影响事件订阅 / 状态上报)。
$stdinAvailable = $true
while ($true) {
  try {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { Start-Sleep -Milliseconds 300; continue }   # stdin EOF (无管道): 纯保活
    $line = $line.Trim()
    if ($line -eq '') { continue }
    $cmdObj = $null
    try { $cmdObj = $line | ConvertFrom-Json } catch { }
    if ($null -eq $cmdObj -or [string]::IsNullOrEmpty([string]$cmdObj.command)) {
      global:EmitControlResult ([string]$cmdObj.command) $false 'invalid command json'
      continue
    }
    global:HandleControlCommand ([string]$cmdObj.command)
  } catch {
    if ($stdinAvailable) {
      $stdinAvailable = $false
      global:Log 'stdin unavailable, control commands disabled (bridge keeps running)'
    }
    Start-Sleep -Milliseconds 500
  }
}
