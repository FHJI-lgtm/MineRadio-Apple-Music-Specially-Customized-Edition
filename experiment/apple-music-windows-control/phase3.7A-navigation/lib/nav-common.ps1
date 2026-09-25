# ============================================================
# phase3.7A-navigation/lib/nav-common.ps1
# Self-contained instrumentation for Apple Music Windows deep-link navigation.
#
# ISOLATION CONTRACT
#   * Nothing here is dot-sourced by the frozen playback path, and this file never
#     modifies anything under poc/lib (am-play / am-uia / am-smtc).
#   * Everything is read-only observation: UIA queries, SMTC queries, window state
#     and launching the app with a URL.  No input synthesis, no SMTC control, no
#     clicks.  This phase answers "did the page change", not "how do we click".
#   * ASCII-only (PowerShell 5.1 parses BOM-less scripts as ANSI; all non-ASCII data
#     lives in JSON).
# ============================================================

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue

if (-not ('AmNav.Native' -as [type])) {
  Add-Type -Namespace AmNav -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT r);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@
}

$script:AmNavExe = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\AppleMusic.exe'
$script:AmNavWindowClass = 'WinUIDesktopWin32WindowClass'
$script:AmNavReportDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'reports'

function Get-AmNavReportDir {
  if (-not (Test-Path $script:AmNavReportDir)) { New-Item -ItemType Directory -Force -Path $script:AmNavReportDir | Out-Null }
  return $script:AmNavReportDir
}

function Write-AmNavText([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}
function Write-AmNavJson([string]$path, $obj) {
  Write-AmNavText $path ($obj | ConvertTo-Json -Depth 8)
}

function Await-AmNavWinRt($op, $resultType, [int]$TimeoutMs = 5000) {
  try {
    $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $t = $m.MakeGenericMethod($resultType).Invoke($null, @($op))
    if (-not $t.Wait($TimeoutMs)) { return $null }
    return $t.Result
  } catch { return $null }
}

function Get-AmNavWindowElement {
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $script:AmNavWindowClass)
    return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  } catch { return $null }
}

function Get-AmNavWindowInfo {
  $res = [ordered]@{ uiaWindowFound = $false; title = ''; className = $script:AmNavWindowClass; hwnd = 0; isForeground = $false
                     foregroundHwnd = 0; foregroundTitle = ''; iconic = $false; visible = $false; rect = ''; processes = @(); error = '' }
  try {
    $res.processes = @(Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $el = Get-AmNavWindowElement
    if ($el -ne $null) {
      $res.uiaWindowFound = $true
      $res.title = '' + $el.Current.Name
      $res.hwnd = [int64]$el.Current.NativeWindowHandle
      if ($res.hwnd -ne 0) {
        $h = [IntPtr]$res.hwnd
        $res.iconic = [AmNav.Native]::IsIconic($h)
        $res.visible = [AmNav.Native]::IsWindowVisible($h)
        $r = New-Object AmNav.Native+RECT
        if ([AmNav.Native]::GetWindowRect($h, [ref]$r)) { $res.rect = ('' + $r.Left + ',' + $r.Top + ',' + $r.Right + ',' + $r.Bottom) }
      }
    }
    $fg = [AmNav.Native]::GetForegroundWindow()
    $res.foregroundHwnd = [int64]$fg
    $sb = New-Object System.Text.StringBuilder 512
    [void][AmNav.Native]::GetWindowText($fg, $sb, 512)
    $res.foregroundTitle = $sb.ToString()
    $res.isForeground = ($res.hwnd -ne 0 -and ([int64]$fg -eq $res.hwnd))
  } catch { $res.error = $_.Exception.Message }
  return $res
}

function Get-AmNavUiaSnapshot {
  param([string[]]$Targets = @(), [int]$NodeCap = 6000, [int]$SampleLimit = 20)
  $res = [ordered]@{ ok = $false; error = ''; elapsedMs = 0; windowTitle = ''; nodeCount = 0; truncated = $false
                     listItemCount = 0; otherControlCounts = @{}; signature = ''; textHits = @{}; patterns = @{}
                     itemSamples = @(); distinctTexts = 0 }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $win = Get-AmNavWindowElement
    if ($win -eq $null) { $res.error = 'apple-music-window-not-found'; $res.elapsedMs = [int]$sw.ElapsedMilliseconds; return $res }
    $res.windowTitle = '' + $win.Current.Name
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $res.nodeCount = $all.Count
    $names = New-Object System.Collections.Generic.List[string]
    $texts = @{}
    foreach ($t in $Targets) { $res.textHits[$t] = $false }
    $n = 0
    foreach ($el in $all) {
      $n++
      if ($n -gt $NodeCap) { $res.truncated = $true; break }
      $ct = ''
      try { $ct = '' + $el.Current.ControlType.ProgrammaticName } catch { $ct = 'unknown' }
      if ($ct -eq 'ControlType.ListItem') {
        $res.listItemCount++
        if ($res.itemSamples.Count -lt $SampleLimit) {
          $res.itemSamples += , ([ordered]@{ name = ('' + $el.Current.Name); automationId = ('' + $el.Current.AutomationId); className = ('' + $el.Current.ClassName) })
        }
      } elseif ($res.otherControlCounts.ContainsKey($ct)) { $res.otherControlCounts[$ct] = $res.otherControlCounts[$ct] + 1 }
      else { $res.otherControlCounts[$ct] = 1 }
      $nm = ''
      try { $nm = '' + $el.Current.Name } catch { $nm = '' }
      if ($nm -ne '') {
        if ($names.Count -lt 400) { $names.Add($nm) }
        $key = $nm.ToLowerInvariant()
        if (-not $texts.ContainsKey($key)) { $texts[$key] = $true }
        foreach ($t in $Targets) {
          if ((-not $res.textHits[$t]) -and $key.Contains($t.ToLowerInvariant())) { $res.textHits[$t] = $true }
        }
      }
    }
    $res.distinctTexts = $texts.Count
    # virtualization / interaction patterns on the first few list items
    foreach ($p in @(
        @{ name = 'ScrollItemPattern'; type = [System.Windows.Automation.ScrollItemPattern] },
        @{ name = 'VirtualizedItemPattern'; type = [System.Windows.Automation.VirtualizedItemPattern] },
        @{ name = 'InvokePattern'; type = [System.Windows.Automation.InvokePattern] },
        @{ name = 'SelectionItemPattern'; type = [System.Windows.Automation.SelectionItemPattern] })) {
      $res.patterns[$p.name] = 'not-tested'
    }
    $items = @($all | Where-Object { try { ('' + $_.Current.ControlType.ProgrammaticName) -eq 'ControlType.ListItem' } catch { $false } })
    $probe = @($items | Select-Object -First 20)
    $counts = @{}
    foreach ($k in @('ScrollItemPattern', 'VirtualizedItemPattern', 'InvokePattern', 'SelectionItemPattern')) { $counts[$k] = 0 }
    foreach ($el in $probe) {
      foreach ($k in @('ScrollItemPattern', 'VirtualizedItemPattern', 'InvokePattern', 'SelectionItemPattern')) {
        $obj = $null
        try {
          $pat = switch ($k) {
            'ScrollItemPattern' { [System.Windows.Automation.ScrollItemPattern]::Pattern }
            'VirtualizedItemPattern' { [System.Windows.Automation.VirtualizedItemPattern]::Pattern }
            'InvokePattern' { [System.Windows.Automation.InvokePattern]::Pattern }
            'SelectionItemPattern' { [System.Windows.Automation.SelectionItemPattern]::Pattern }
          }
          if ($el.TryGetCurrentPattern($pat, [ref]$obj)) { $counts[$k] = $counts[$k] + 1 }
        } catch { }
      }
    }
    foreach ($k in $counts.Keys) { $res.patterns[$k] = ('' + $counts[$k] + '/' + $probe.Count) }
    $sigText = ($names -join '|')
    if ($sigText -eq '') { $res.signature = 'empty' } else {
      $md5 = [System.Security.Cryptography.MD5]::Create()
      $res.signature = [System.BitConverter]::ToString($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sigText))).Replace('-', '').Substring(0, 16)
    }
    $res.ok = $true
  } catch { $res.error = $_.Exception.Message }
  $res.elapsedMs = [int]$sw.ElapsedMilliseconds
  return $res
}

function Get-AmNavSmtcSnapshot {
  $res = [ordered]@{ ok = $false; error = ''; source = ''; title = ''; artist = ''; album = ''; status = ''; sessions = 0 }
  try {
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    # static call through a type held in a variable: use reflection, because the
    # "[$var]::Member" form is not valid PowerShell syntax
    $flags = [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static -bor [System.Reflection.BindingFlags]::InvokeMethod
    $mgrOp = $mgrType.InvokeMember('RequestAsync', $flags, $null, $null, @())
    $mgr = Await-AmNavWinRt $mgrOp $mgrType 5000
    if ($mgr -eq $null) { $res.error = 'smtc-manager-unavailable'; return $res }
    $sessions = @($mgr.GetSessions())
    $res.sessions = $sessions.Count
    $sess = $null
    foreach ($s in $sessions) { if (('' + $s.SourceAppUserModelId) -like '*AppleMusic*') { $sess = $s; break } }
    if ($sess -eq $null) { $res.error = 'no-apple-music-session'; return $res }
    $res.source = '' + $sess.SourceAppUserModelId
    $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    $props = Await-AmNavWinRt ($sess.TryGetMediaPropertiesAsync()) $propsType 5000
    if ($props -ne $null) { $res.title = '' + $props.Title; $res.artist = '' + $props.Artist; $res.album = '' + $props.AlbumTitle }
    $info = $sess.GetPlaybackInfo()
    if ($info -ne $null) { $res.status = '' + $info.PlaybackStatus }
    $res.ok = $true
  } catch { $res.error = $_.Exception.Message }
  return $res
}

function Invoke-AmNavDeepLink {
  param([string]$Url, [string]$Method = 'url', [int]$SettleMs = 400)
  $r = [ordered]@{ method = $Method; url = $Url; command = ''; started = $false; pid = 0; exitCode = $null
                   launcherStillRunning = $false; elapsedMs = 0; error = '' }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    if ($Method -eq 'shell') {
      $r.command = 'Start-Process "<url>"   (ShellExecute)'
      $p = Start-Process -FilePath $Url -PassThru -ErrorAction Stop
    } else {
      if (-not (Test-Path $script:AmNavExe)) { throw ('AppleMusic.exe not found at ' + $script:AmNavExe) }
      $r.command = 'AppleMusic.exe /url "<url>"'
      $p = Start-Process -FilePath $script:AmNavExe -ArgumentList @('/url', $Url) -PassThru -ErrorAction Stop
    }
    if ($p -ne $null) {
      $r.started = $true
      $r.pid = $p.Id
      Start-Sleep -Milliseconds $SettleMs
      $p2 = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
      if ($p2 -eq $null) { $r.exitCode = 0 } else { $r.launcherStillRunning = $true }
    }
  } catch { $r.error = $_.Exception.Message }
  $r.elapsedMs = [int]$sw.ElapsedMilliseconds
  return $r
}

# Bounded, honest timeline sampler: real elapsed time is recorded for every point.
function Measure-AmNavTimeline {
  param([string]$Url, [string]$Method = 'url', [string[]]$Targets = @(), [int[]]$Points = @(0, 250, 500, 1000, 2000, 4000, 6000, 8000, 12000))
  $preWindow = Get-AmNavWindowInfo
  $preUia = Get-AmNavUiaSnapshot -Targets $Targets
  $preSmtc = Get-AmNavSmtcSnapshot
  $inv = Invoke-AmNavDeepLink -Url $Url -Method $Method
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $timeline = New-Object System.Collections.Generic.List[object]
  foreach ($pt in $Points) {
    $wait = $pt - [int]$sw.ElapsedMilliseconds
    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
    $w = Get-AmNavWindowInfo
    $u = Get-AmNavUiaSnapshot -Targets $Targets
    $s = Get-AmNavSmtcSnapshot
    $timeline.Add([ordered]@{
        pointMs = $pt; actualMs = [int]$sw.ElapsedMilliseconds
        windowTitle = $w.title; isForeground = $w.isForeground; iconic = $w.iconic; visible = $w.visible
        uiaElapsedMs = $u.elapsedMs; uiaOk = $u.ok; uiaError = $u.error
        nodeCount = $u.nodeCount; listItemCount = $u.listItemCount; distinctTexts = $u.distinctTexts
        signature = $u.signature; textHits = $u.textHits; patterns = $u.patterns
        smtcTitle = $s.title; smtcArtist = $s.artist; smtcStatus = $s.status; smtcError = $s.error
      })
  }
  return [ordered]@{ pre = [ordered]@{ window = $preWindow; uia = $preUia; smtc = $preSmtc }
                     invocation = $inv; timeline = $timeline
                     final = $timeline[$timeline.Count - 1] }
}

function Invoke-AmNavItunesLookup([string]$Id, [string]$Storefront = 'cn') {
  try {
    $uri = 'https://itunes.apple.com/lookup?id=' + [uri]::EscapeDataString($Id) + '&entity=song&country=' + $Storefront
    $raw = (Invoke-WebRequest -Uri $uri -TimeoutSec 20 -UseBasicParsing -Headers @{ 'User-Agent' = 'mineradio-phase37a' }).Content
    $j = $raw | ConvertFrom-Json
    if ($j.resultCount -gt 0) {
      $t = $j.results[0]
      return @{ ok = $true; title = ('' + $t.trackName); artist = ('' + $t.artistName); album = ('' + $t.collectionName)
                collectionId = ('' + $t.collectionId); trackId = ('' + $t.trackId); url = ('' + $t.trackViewUrl) }
    }
    return @{ ok = $false; collectionId = ''; error = 'empty-result' }
  } catch { return @{ ok = $false; collectionId = ''; error = $_.Exception.Message } }
}
