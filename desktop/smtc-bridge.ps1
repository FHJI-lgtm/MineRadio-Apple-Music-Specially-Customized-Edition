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
    # [SMTC-LIFECYCLE-FIX] 有限超时: WinRT task 在切歌瞬间可能永久挂起.
    # 无限 Wait(-1) 会永久阻塞 event action runspace -> runspace 池耗尽 -> SMTC 停更.
    # Wait(3000) 超时返回 false, 本函数返回 null (所有调用方已处理 null),
    # 不抛异常、不退出 bridge、不阻塞事件循环; 下一次 event/poll 仍可执行.
    if (-not $netTask.Wait(3000)) {
      global:Log 'async task timeout (3000ms): task did not complete'
      return $null
    }
    return $netTask.Result
  } catch {
    global:Log ('Await failed: ' + $_.Exception.Message)
    return $null
  }
}

# ---- Phase 4A: album cover (Thumbnail -> base64 data URL) ----
# Read only when the track identity changes; any failure returns $null (never crashes),
# the renderer falls back to a default cover.
#
# [THUMB-FIX 2026-10-06] Root cause of the long-standing "thumbnail=null" (measured, see
# docs/ARTWORK_PIPELINE_AUDIT.md section 7):
#   WinRT OpenReadAsync() hands back a System.__ComObject;
#   PowerShell's [Type] cast goes through LanguagePrimitives and FAILS 100% of the time
#   ("Cannot convert System.__ComObject to IRandomAccessStream").
#   The working channel is MethodInfo.Invoke: the CLR binder performs the COM QI itself.
#   Measured gain: 66024B JPEG / 600x600 / 15ms (the old path wasted 3 x ~3s per track, then failed).
# Contract unchanged: data:image/...;base64,... on success, $null on failure.
#
# MethodInfo cache policy: lazy init + automatic rebuild on any failure.
#   Never assume $global: is visible in every runspace; every call reads the cache and,
#   if it is missing or throws, drops it and rebuilds once -- a stale cache can never
#   turn into a permanent fallback.
# NOTE: keep comments in this file ASCII-only. This script is UTF-8 *without* BOM and
#   PowerShell 5.1 decodes it as ANSI; non-ASCII bytes can swallow following punctuation
#   and break the parser. (Pre-existing non-ASCII comments elsewhere are untouched.)
$global:ThumbProbeCache = $null

function global:GetThumbProbe {
  param([switch]$Force)
  if (-not $Force -and $null -ne $global:ThumbProbeCache) {
    $c = $global:ThumbProbeCache
    if ($null -ne $c.GetStream -and $null -ne $c.AsStream) { return $c }
  }
  try {
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [System.IO.WindowsRuntimeStreamExtensions]
    $iracT = [Type]::GetType('Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime')
    if ($null -eq $iracT) { $global:ThumbProbeCache = $null; return $null }
    $getIn = $iracT.GetMethod('GetInputStreamAt')
    $getSize = $iracT.GetMethod('get_Size')
    $asStream = ([System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IInputStream'
    })[0]
    if ($null -eq $getIn -or $null -eq $asStream) { $global:ThumbProbeCache = $null; return $null }
    $global:ThumbProbeCache = @{ GetStream = $getIn; GetSize = $getSize; AsStream = $asStream }
    return $global:ThumbProbeCache
  } catch {
    $global:ThumbProbeCache = $null
    return $null
  }
}

# pure helper: magic sniff (ContentType is measured EMPTY -> never rely on it)
function global:ThumbBytesToFormat($bytes) {
  if ($null -eq $bytes -or $bytes.Length -lt 12) { return 'unknown' }
  if ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { return 'jpeg' }
  if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) { return 'png' }
  if ($bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x46 -and $bytes[3] -eq 0x46 -and
      $bytes[8] -eq 0x57 -and $bytes[9] -eq 0x45 -and $bytes[10] -eq 0x42 -and $bytes[11] -eq 0x50) { return 'webp' }
  return 'unknown'
}

# pure helper: image size from header (logging/acceptance only; no full decode)
function global:ThumbImageSize($bytes, $format) {
  try {
    if ($format -eq 'png') {
      $w = [int]$bytes[16] * 16777216 + [int]$bytes[17] * 65536 + [int]$bytes[18] * 256 + [int]$bytes[19]
      $h = [int]$bytes[20] * 16777216 + [int]$bytes[21] * 65536 + [int]$bytes[22] * 256 + [int]$bytes[23]
      return @($w, $h)
    }
    if ($format -eq 'webp') {
      $tag = [System.Text.Encoding]::ASCII.GetString($bytes, 12, 4)
      if ($tag -eq 'VP8X') {
        $w = ([int]$bytes[24] + ([int]$bytes[25] -shl 8) + ([int]$bytes[26] -shl 16)) + 1
        $h = ([int]$bytes[27] + ([int]$bytes[28] -shl 8) + ([int]$bytes[29] -shl 16)) + 1
        return @($w, $h)
      }
      if ($tag -eq 'VP8L') {
        $b0 = [int]$bytes[21]; $b1 = [int]$bytes[22]; $b2 = [int]$bytes[23]; $b3 = [int]$bytes[24]
        $w = (($b0 -bor ($b1 -shl 8)) -band 0x3FFF) + 1
        $h = (((($b1 -shr 6) -bor ($b2 -shl 2) -bor ($b3 -shl 10)) -band 0x3FFF)) + 1
        return @($w, $h)
      }
      $w = (([int]$bytes[26] -bor ([int]$bytes[27] -shl 8))) -band 0x3FFF
      $h = (([int]$bytes[28] -bor ([int]$bytes[29] -shl 8))) -band 0x3FFF
      return @($w, $h)
    }
    if ($format -eq 'jpeg') {
      $i = 2
      while ($i -lt $bytes.Length - 9) {
        if ($bytes[$i] -ne 0xFF) { $i++; continue }
        $m = $bytes[$i + 1]
        if ($m -eq 0xD8 -or $m -eq 0x01 -or ($m -ge 0xD0 -and $m -le 0xD7)) { $i += 2; continue }
        $len = ([int]$bytes[$i + 2] -shl 8) + [int]$bytes[$i + 3]
        if (($m -ge 0xC0 -and $m -le 0xC3) -or ($m -ge 0xC5 -and $m -le 0xC7) -or
            ($m -ge 0xC9 -and $m -le 0xCB) -or ($m -ge 0xCD -and $m -le 0xCF)) {
          $h = ([int]$bytes[$i + 5] -shl 8) + [int]$bytes[$i + 6]
          $w = ([int]$bytes[$i + 7] -shl 8) + [int]$bytes[$i + 8]
          return @($w, $h)
        }
        if ($len -lt 2) { break }
        $i += 2 + $len
      }
    }
  } catch { }
  return $null
}

# pure helper: bytes -> data URL (keeps the original 5MB guard)
function global:ThumbBytesToDataUrl($bytes) {
  if ($null -eq $bytes -or $bytes.Length -lt 4 -or $bytes.Length -gt 5242880) { return $null }
  $format = global:ThumbBytesToFormat $bytes
  $mime = 'image/jpeg'
  if ($format -eq 'png') { $mime = 'image/png' }
  elseif ($format -eq 'webp') { $mime = 'image/webp' }
  return ('data:' + $mime + ';base64,' + [Convert]::ToBase64String($bytes))
}

function global:ReadThumbnailDataUrl($props) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    if ($null -eq $props -or $null -eq $props.Thumbnail) {
      global:Log '[SMTC][THUMB] read failed: no thumbnail reference'
      return $null
    }
    $stream = global:Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $stream) {
      global:Log '[SMTC][THUMB] read failed: OpenReadAsync returned null'
      return $null
    }
    # [THUMB-FIX] get IInputStream through MethodInfo.Invoke (a [Type] cast always fails here)
    $probe = global:GetThumbProbe
    $netStream = $null
    for ($attempt = 0; $attempt -lt 2 -and $null -eq $netStream; $attempt++) {
      if ($null -eq $probe) { $probe = global:GetThumbProbe -Force }
      if ($null -eq $probe) { break }
      try {
        $inStream = $probe.GetStream.Invoke($stream, @([uint64]0))
        if ($null -ne $inStream) { $netStream = $probe.AsStream.Invoke($null, @($inStream)) }
      } catch { }
      if ($null -eq $netStream) {
        # stale cached MethodInfo (runspace lifecycle change etc.) -> drop and rebuild once
        $global:ThumbProbeCache = $null
        $probe = $null
      }
    }
    if ($null -eq $netStream) {
      global:Log '[SMTC][THUMB] read failed: cannot project thumbnail stream'
      return $null
    }
    $streamSize = 0
    try { if ($null -ne $probe.GetSize) { $streamSize = [int64]$probe.GetSize.Invoke($stream, @()) } } catch { }
    $ms = New-Object System.IO.MemoryStream
    # [SMTC-LIFECYCLE-FIX] bounded synchronous read.
    #   The old CopyToAsync path throws on this stream type (InputStreamOverStream:
    #   "Value cannot be ..."), so read in 64KB chunks and enforce a total time budget
    #   instead of relying on an async copy. Same intent: never hang the event runspace.
    try {
      $buf = New-Object byte[] 65536
      $total = 0
      while ($true) {
        if ($sw.ElapsedMilliseconds -gt 3000) {
          global:Log '[SMTC][THUMB] read failed: stream read timeout (3000ms)'
          return $null
        }
        $n = $netStream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $ms.Write($buf, 0, $n)
        $total += $n
        if ($total -gt 5242880) {
          global:Log '[SMTC][THUMB] read failed: thumbnail larger than 5MB'
          return $null
        }
      }
    } catch {
      global:Log ('[SMTC][THUMB] read failed: ' + $_.Exception.Message)
      return $null
    }
    try { if ($null -ne $netStream -and $netStream.CanRead) { $netStream.Dispose() } } catch { }
    $bytes = $ms.ToArray()
    if ($bytes.Length -lt 4 -or $bytes.Length -gt 5242880) {
      global:Log ('[SMTC][THUMB] read failed: implausible size ' + $bytes.Length)
      return $null
    }
    $sw.Stop()
    $format = global:ThumbBytesToFormat $bytes
    $dim = global:ThumbImageSize $bytes $format
    $dimText = ''
    if ($null -ne $dim) { $dimText = ' ' + $dim[0] + 'x' + $dim[1] }
    global:Log ('[SMTC][THUMB] stream=' + $streamSize + 'B')
    global:Log ('[SMTC][THUMB] read=' + $bytes.Length + 'B ' + $sw.ElapsedMilliseconds + 'ms')
    global:Log ('[SMTC][THUMB] ' + $format + $dimText)
    $dataUrl = global:ThumbBytesToDataUrl $bytes
    if ($null -eq $dataUrl) {
      global:Log '[SMTC][THUMB] read failed: data url build failed'
      return $null
    }
    global:Log ('[SMTC][THUMB] accepted len=' + $dataUrl.Length)
    return $dataUrl
  } catch {
    global:Log ('[SMTC][THUMB] read failed: ' + $_.Exception.Message)
    return $null
  }
}

function global:ReadThumbnailWithRetry($props) {
  # [THUMB-FIX] the old 3x retry existed only to paper over the projection bug (100% failure,
  # pure wasted ~10s). After the fix a single attempt succeeds (measured 15ms); a real failure
  # is a real failure, so try once and leave an explicit reason in the log.
  $t = global:ReadThumbnailDataUrl $props
  if ($null -eq $t) { global:Log '[SMTC][THUMB] read failed: giving up after single attempt' }
  return $t
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

# --- Phase 4B: SMTC 播放控制 / 会话刷新 (stdin JSON 命令入口) ---
# 协议:
#   stdin : {"command":"play"|"pause"|"toggle"|"next"|"previous"|"refresh"}
#   stdout: {"type":"control-result","command":"...","success":true[, "error":"..."]}
#   refresh: 重新同步 CurrentSession 并立即推送最新 MediaProperties/PlaybackInfo/Timeline
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
      'refresh' {
        # SMTC 会话刷新: 重新同步当前 Session (SyncSession 已在上方执行,
        # session 变化时 SubscribeSession 会清理旧订阅并按 EventName 去重),
        # 绕过 throttle 强制立即重新读取 MediaProperties/PlaybackInfo/Timeline 并推送。
        $global:SmtcLastEmitMs = 0
        global:EmitState $null
        global:EmitControlResult 'refresh' $true $null
      }
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

# 保活 + Phase 4B: stdin JSON 控制命令入口 (非阻塞版)
# PS 5.1 关键约束: 主 runspace 若阻塞在 [Console]::In.ReadLine() 上,
# Register-ObjectEvent 的事件泵送会被冻结 (poll/Media/Playback/Timeline
# 全部排队不执行 -> SMTC 状态停更)。因此:
#   - stdin 由独立后台 runspace 阻塞读取, 行写入共享线程安全队列
#   - 主 runspace 保活循环非阻塞 TryDequeue, 其余时间 Start-Sleep 保持空闲
# 命令协议不变: {"command":"play"|"pause"|"toggle"|"next"|"previous"}
$global:SmtcCmdQueue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$global:SmtcStdinReaderHandle = $null
$global:SmtcStdinReaderPs = $null
$global:SmtcStdinReaderRs = $null
try {
  $global:SmtcStdinReaderRs = [runspacefactory]::CreateRunspace()
  $global:SmtcStdinReaderRs.Open()
  $global:SmtcStdinReaderPs = [powershell]::Create()
  $global:SmtcStdinReaderPs.Runspace = $global:SmtcStdinReaderRs
  $readerScript = {
    param($queue, $stream)
    try {
      $rd = New-Object System.IO.StreamReader($stream)
      while ($true) {
        $line = $rd.ReadLine()
        if ($null -eq $line) { Start-Sleep -Milliseconds 250; continue }   # stdin EOF: 纯保活
        try { $queue.Enqueue([string]$line) } catch { }
      }
    } catch { }
  }
  [void]$global:SmtcStdinReaderPs.AddScript($readerScript)
  [void]$global:SmtcStdinReaderPs.AddArgument($global:SmtcCmdQueue)
  [void]$global:SmtcStdinReaderPs.AddArgument([Console]::OpenStandardInput())
  $global:SmtcStdinReaderHandle = $global:SmtcStdinReaderPs.BeginInvoke()
  global:Log 'stdin reader started (background runspace)'
} catch {
  global:Log ('stdin reader start failed: ' + $_.Exception.Message)
}

$stdinUnavailableLogged = $false
while ($true) {
  try {
    $line = ''
    if ($global:SmtcCmdQueue.TryDequeue([ref]$line) -and -not [string]::IsNullOrWhiteSpace($line)) {
      $cmdObj = $null
      try { $cmdObj = $line | ConvertFrom-Json } catch { }
      if ($null -eq $cmdObj -or [string]::IsNullOrEmpty([string]$cmdObj.command)) {
        global:EmitControlResult ([string]$cmdObj.command) $false 'invalid command json'
      } else {
        global:HandleControlCommand ([string]$cmdObj.command)
      }
    }
  } catch {
    if (-not $stdinUnavailableLogged) {
      $stdinUnavailableLogged = $true
      global:Log 'control loop error, control commands may be unavailable (bridge keeps running)'
    }
  }
  Start-Sleep -Milliseconds 200
}
