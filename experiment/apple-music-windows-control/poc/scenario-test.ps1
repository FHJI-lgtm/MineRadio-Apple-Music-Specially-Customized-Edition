# ============================================================
# poc/scenario-test.ps1
# Environment / edge-case scenarios. Deliberately SEPARATE from the 60-attempt
# stability statistics: an "occluded window" failure here must not pollute the
# core success rate measured by stability-test.ps1.
#
# Scenarios:
#   S1 app already open            -> normal play
#   S2 app not running             -> engine must launch it, then play
#   S3 A -> B -> C switching       -> three plays in a row
#   S4 same song repeated x3       -> no false positives from the previous run
#   S5 ambiguous title             -> how many candidates match, which one wins
#   S6 song that does not exist    -> must report RESULT_NOT_FOUND
#   S7 window maximized            -> play while maximized
#   S8 window normal size          -> play while not maximized
#   S9 window covered by Notepad   -> foregrounding should still let it play
#   S10 covered + -NoForeground    -> measures whether foregrounding is required
#
# Usage: powershell -ExecutionPolicy Bypass -File poc\scenario-test.ps1
# ASCII-only on purpose (titles come from songs.json as UTF-8).
# ============================================================
[CmdletBinding()]
param(
  [string]$SongIdForWindowTests = 'A'
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot 'lib\am-smtc.ps1')
. (Join-Path $PSScriptRoot 'lib\am-uia.ps1')
. (Join-Path $PSScriptRoot 'lib\am-play.ps1')

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class AmScen {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
try { Add-Type -TypeDefinition $sig -Language CSharp -ErrorAction Stop } catch { }

$findings = Get-AmFindingsDir
$stamp = Get-AmStamp
$jsonl = Join-Path $findings ('scenarios-' + $stamp + '.jsonl')
$md = Join-Path $findings ('scenarios-' + $stamp + '.md')
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $lines.Add($t); Write-Host $t }

$songs = @(Get-AmFrozenSongs)
$byId = @{}
foreach ($s in $songs) { $byId[$s.id] = $s }
$A = $byId['A']; $B = $byId['B']; $C = $byId['C']
$W = $byId[$SongIdForWindowTests]

function PlayOne([string]$scenario, $song, [switch]$NoLaunch, [switch]$NoForeground, [string]$titleOverride = '', [string]$artistOverride = '', [string]$urlOverride = '__keep__') {
  $title = $song.title; $artist = $song.artist; $url = $song.url
  if ($titleOverride) { $title = $titleOverride }
  if ($artistOverride) { $artist = $artistOverride }
  if ($urlOverride -ne '__keep__') { $url = $urlOverride }
  $r = Invoke-AmPlaySong -Title $title -Artist $artist -SongId $song.id -Url $url -Retries 1 -PauseFirst -NoLaunch:$NoLaunch -NoForeground:$NoForeground
  $rec = [ordered]@{
    scenario = $scenario; songId = $song.id; title = $title; artist = $artist; url = $url
    ok = $r.ok; stage = $r.stage; mode = $r.mode; attempts = $r.attempts
    e2eMs = $r.t.e2eMs; ensureAppMs = $r.t.ensureAppMs; smtcMs = $r.t.smtcMs; settleMs = $r.t.settleMs
    appLaunched = $r.appLaunched; windowRestored = $r.window.restored; noForeground = [bool]$r.noForeground
    candidateCount = $r.candidateCount; ambiguous = $r.ambiguous; pickedByPosition = $r.pickedByPosition
    matchedRow = $r.matchedRow; smtcTitle = $r.smtc.title; smtcArtist = $r.smtc.artist; smtcStatus = $r.smtc.status
    stageDetail = $r.stageDetail; stageHistory = ($r.stageHistory -join '>'); ts = $r.ts
  }
  Add-AmJsonLine $jsonl $rec
  $flag = 'FAIL'
  if ($r.ok) { $flag = 'OK  ' }
  Say ('  [' + $flag + '] ' + $scenario + ' song=' + $song.id + ' stage=' + $r.stage + ' e2e=' + $r.t.e2eMs + 'ms launch=' + $r.appLaunched + ' ensureApp=' + $r.t.ensureAppMs + 'ms cand=' + $r.candidateCount + ' amb=' + $r.ambiguous)
  if ($r.stageDetail) { Say ('         detail: ' + $r.stageDetail) }
  return $r
}

Say ('# Scenario test ' + $stamp)
Say ''
Say ('songs: ' + (($songs | ForEach-Object { $_.id }) -join ', ') + '   window-test song: ' + $W.id)
Say ''

Write-Host '=== S1: app already open ==='
$p = Get-AmProcess
if (-not $p) { [void](Ensure-AmRunning 30000) }
PlayOne 'S1_app_open' $A | Out-Null

Write-Host '=== S2: app not running (must be launched by the engine) ==='
Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
PlayOne 'S2_app_closed' $A | Out-Null

Write-Host '=== S3: A -> B -> C switching ==='
PlayOne 'S3_switch_A' $A | Out-Null
PlayOne 'S3_switch_B' $B | Out-Null
PlayOne 'S3_switch_C' $C | Out-Null

Write-Host '=== S4: same song three times ==='
for ($i = 1; $i -le 3; $i++) { PlayOne ('S4_repeat_' + $i) $A | Out-Null }

Write-Host '=== S5: ambiguous title (search path, many versions) ==='
$s5 = @{ id = 'A'; title = $A.title; artist = ''; url = '' }
$r5 = Invoke-AmPlaySong -Title $A.title -Artist '' -SongId 'A' -Url '' -Retries 0 -PauseFirst
$rec5 = [ordered]@{ scenario = 'S5_ambiguous_title'; songId = 'A'; title = $A.title; artist = ''; url = ''; ok = $r5.ok; stage = $r5.stage; mode = $r5.mode; candidateCount = $r5.candidateCount; ambiguous = $r5.ambiguous; pickedByPosition = $r5.pickedByPosition; matchedRow = $r5.matchedRow; smtcTitle = $r5.smtc.title; smtcArtist = $r5.smtc.artist; e2eMs = $r5.t.e2eMs; stageDetail = $r5.stageDetail; ts = $r5.ts }
Add-AmJsonLine $jsonl $rec5
Say ('  [info] S5_ambiguous_title stage=' + $r5.stage + ' candidates=' + $r5.candidateCount + ' ambiguous=' + $r5.ambiguous + ' pickedByPosition=' + $r5.pickedByPosition)

Write-Host '=== S6: song that does not exist ==='
$ghost = @{ id = 'GHOST'; title = 'zzz not a real song 9988 qq'; artist = 'nobody at all'; url = ''; smtcTitle = '' }
PlayOne 'S6_not_found' $ghost | Out-Null

Write-Host '=== S7: window maximized ==='
$p = Get-AmProcess
if ($p) { [void][AmScen]::ShowWindow($p.MainWindowHandle, 3); Start-Sleep -Milliseconds 800 }   # SW_MAXIMIZE
PlayOne 'S7_window_maximized' $W | Out-Null

Write-Host '=== S8: window normal size ==='
$p = Get-AmProcess
if ($p) { [void][AmScen]::ShowWindow($p.MainWindowHandle, 9); Start-Sleep -Milliseconds 800 }   # SW_RESTORE (un-maximize)
PlayOne 'S8_window_normal' $W | Out-Null

Write-Host '=== S9: window covered by Notepad (foregrounding enabled) ==='
$np = Start-Process notepad -PassThru
Start-Sleep -Seconds 2
$am = Get-AmProcess
if ($am -and $np) {
  $r = New-Object AmScen+RECT
  [void][AmScen]::GetWindowRect($am.MainWindowHandle, [ref]$r)
  [void][AmScen]::SetWindowPos($np.MainWindowHandle, [IntPtr]::Zero, $r.Left + 200, $r.Top + 200, 900, 700, 0x0040)
  [void][AmScen]::SetForegroundWindow($np.MainWindowHandle)
  Start-Sleep -Milliseconds 800
}
PlayOne 'S9_covered_foreground_on' $W | Out-Null

Write-Host '=== S10: still covered, but foregrounding disabled ==='
if ($am -and $np) {
  $r = New-Object AmScen+RECT
  [void][AmScen]::GetWindowRect($am.MainWindowHandle, [ref]$r)
  [void][AmScen]::SetWindowPos($np.MainWindowHandle, [IntPtr]::Zero, $r.Left + 200, $r.Top + 200, 900, 700, 0x0040)
  [void][AmScen]::SetForegroundWindow($np.MainWindowHandle)
  Start-Sleep -Milliseconds 800
}
PlayOne 'S10_covered_foreground_off' $W -NoForeground | Out-Null
if ($np) { Stop-Process -Id $np.Id -Force -ErrorAction SilentlyContinue }

Write-AmText $md ($lines -join "`r`n")
Write-Host ''
Write-Host ('report: ' + $md)
Write-Host ('jsonl : ' + $jsonl)
