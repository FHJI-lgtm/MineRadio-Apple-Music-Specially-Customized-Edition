# ============================================================
# 10-uia-tree-and-search-poc.ps1
#
# Part A: dump the UI Automation tree of the Apple Music window (WinUI3 app: class
#         WinUIDesktopWin32WindowClass) to see what is actually automatable.
# Part B: PoC - search for the target song in Apple Music via UI Automation and play it,
#         verifying the result through SMTC (title + PlaybackStatus).
#
# Target: How Do I Make You Love Me?  (song id 1603171530)
#
# Safety: uses only the official Windows UI Automation API against the user's own running app.
#         No process injection, no client modification, no credentials, no DRM work.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\10-uia-tree-and-search-poc.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$outFile = Join-Path $outDir '10-uia-tree-and-search-poc.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

$SONG_TITLE = 'How Do I Make You Love Me?'
$SONG_ID = '1603171530'

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]

function Await($WinRtTask, [Type]$ResultType) {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(8000) | Out-Null
  return $netTask.Result
}

function Get-Smtc {
  $out = @{ title = ''; artist = ''; status = ''; pos = ''; dur = '' }
  try {
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    foreach ($s in $mgr.GetSessions()) {
      if (('' + $s.SourceAppUserModelId) -notmatch 'AppleMusic') { continue }
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      if ($p) { $out.title = '' + $p.Title; $out.artist = '' + $p.Artist }
      $i = $s.GetPlaybackInfo()
      if ($i) { $out.status = '' + $i.PlaybackStatus }
      $t = $s.GetTimelineProperties()
      if ($t) { $out.pos = '' + $t.Position; $out.dur = '' + $t.EndTime }
      break
    }
  } catch { }
  return $out
}

$proc = Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue
if (-not $proc) { Say 'AppleMusic.exe not running - run 08 first'; exit 1 }
Say ('AppleMusic pid=' + $proc.Id + ' hwnd=' + $proc.MainWindowHandle)

$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $root) { Say 'FromHandle returned null'; exit 1 }
Say ('root: name="' + $root.Current.Name + '" class=' + $root.Current.ClassName + ' type=' + $root.Current.ControlType.ProgrammaticName)

Say ''
Say '=== A. UIA tree (descendants, depth <= 6, max 200 nodes) ==='
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$count = 0
function Walk($el, [int]$depth) {
  if ($script:count -ge 200 -or $depth -gt 6 -or -not $el) { return }
  $script:count += 1
  try {
    $c = $el.Current
    $name = '' + $c.Name
    if ($name.Length -gt 60) { $name = $name.Substring(0, 60) + '...' }
    Say ('  ' + ('  ' * $depth) + $c.ControlType.ProgrammaticName.Replace('ControlType.', '') + '  name="' + $name + '"  cls=' + $c.ClassName + '  autoId=' + $c.AutomationId)
  } catch { }
  try {
    $child = $walker.GetFirstChild($el)
    while ($child) {
      Walk $child ($depth + 1)
      $child = $walker.GetNextSibling($child)
    }
  } catch { }
}
Walk $root 0
Say ('  (nodes visited: ' + $script:count + ')')

Say ''
Say '=== B. Search for Edit / search controls ==='
$editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
Say ('  Edit controls found: ' + $edits.Count)
for ($i = 0; $i -lt $edits.Count; $i++) {
  $e = $edits.Item($i)
  Say ('    [' + $i + '] name="' + $e.Current.Name + '" autoId="' + $e.Current.AutomationId + '" cls=' + $e.Current.ClassName + ' enabled=' + $e.Current.IsEnabled)
}

Say ''
Say '=== C. PoC: search + play via UI Automation ==='
$target = $null
for ($i = 0; $i -lt $edits.Count; $i++) {
  $e = $edits.Item($i)
  if ($e.Current.IsEnabled) { $target = $e; break }
}
if (-not $target) {
  Say '  no enabled Edit control -> UI Automation search not available in this build'
} else {
  Say ('  using Edit: name="' + $target.Current.Name + '" autoId="' + $target.Current.AutomationId + '"')
  $before = Get-Smtc
  Say ('  SMTC before: title="' + $before.title + '" status=' + $before.status)
  try {
    $vp = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $target.SetFocus()
    Start-Sleep -Milliseconds 500
    $vp.SetValue($SONG_TITLE)
    Say ('  SetValue("' + $SONG_TITLE + '") issued')
  } catch {
    Say ('  ValuePattern failed: ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds 4
  Say ''
  Say '  result list items after search (ListItem / DataItem / Button with the title):'
  $any = $false
  foreach ($ct in @([System.Windows.Automation.ControlType]::ListItem, [System.Windows.Automation.ControlType]::DataItem, [System.Windows.Automation.ControlType]::Button, [System.Windows.Automation.ControlType]::Text)) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
    $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    for ($i = 0; $i -lt $items.Count; $i++) {
      $it = $items.Item($i)
      $n = '' + $it.Current.Name
      if ($n -match 'How Do I Make You Love Me') {
        $any = $true
        Say ('    MATCH ' + $ct.ProgrammaticName + ' name="' + $n + '" autoId=' + $it.Current.AutomationId + ' cls=' + $it.Current.ClassName)
      }
    }
  }
  if (-not $any) { Say '    (no element name matched the target title)' }
}

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
