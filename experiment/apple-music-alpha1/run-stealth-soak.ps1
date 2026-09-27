# ============================================================
# experiment/apple-music-alpha1/run-stealth-soak.ps1
# 30-minute soak of the stealth state (Alpha=1 + WS_EX_LAYERED + WS_EX_TRANSPARENT).
#
#   .\run-stealth-soak.ps1                     30 min, sample every 10 s
#   .\run-stealth-soak.ps1 -Minutes 2 -IntervalSec 5 -NavEverySec 30   (short smoke run)
#
# Every sample records: timestamp, HWND, IsWindow, IsHungAppWindow, alpha, exStyle, layered,
# transparent, UIA root / descendants / listItems / treeSignature, SMTC status+track+position,
# WindowFromPoint at N relative points (stillAppleMusic count), DPI, virtual screen, foreground,
# the perturbation that just happened, and the stealth/restore state.
# Any of these flips => VIOLATION with a full snapshot at the first occurrence:
#   alpha != requested | WS_EX_LAYERED lost | WS_EX_TRANSPARENT lost | UIA root unavailable
#   | SMTC provider lost | WindowFromPoint hits Apple Music | IsWindow=false
# Perturbations: UIA page navigation every NavEverySec, plus ResizeCount window move/resize events.
# No input is synthesized during the soak, so the machine stays usable while it runs.
# End: alpha->255, clear both style bits, original exStyle, SW_MINIMIZE, final UIA/SMTC check.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [int]$Minutes = 30,
  [int]$IntervalSec = 10,
  [int]$NavEverySec = 180,
  [int]$ResizeCount = 4,
  [int]$PointCount = 8,
  [int]$Alpha = 1
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

$alphaRoot = $PSScriptRoot
$expRoot = Split-Path $alphaRoot -Parent
$pocLib = Join-Path $expRoot 'apple-music-windows-control\poc\lib'
. (Join-Path $pocLib 'am-common.ps1')
. (Join-Path $pocLib 'am-smtc.ps1')
. (Join-Path $pocLib 'am-uia.ps1')
. (Join-Path $alphaRoot 'lib\alpha-common.ps1')

$stamp = Get-Alpha1Stamp
$repDir = Get-Alpha1ReportDir
$jsonlPath = Join-Path $repDir ($stamp + '-soak.jsonl')
$txtPath = Join-Path $repDir ($stamp + '-soak.txt')
$sumPath = Join-Path $repDir ($stamp + '-soak-summary.json')
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$lines = New-Object System.Collections.ArrayList
function Say([string]$t) { [void]$lines.Add($t); Write-Host $t }
function Append-Line([string]$t) { [System.IO.File]::AppendAllText($jsonlPath, ($t + [Environment]::NewLine), $utf8NoBom) }

$script:t0 = Get-Date
function Elapsed { return [math]::Round(((Get-Date) - $script:t0).TotalSeconds, 1) }

# ---------------- discovery + recipe ----------------
$sel0 = Select-Alpha1Target
if (-not $sel0.selected) { Write-Host 'FATAL: no Apple Music window'; exit 3 }
$preIconic = [bool]$sel0.selected.iconic
$hwnd = [IntPtr][int64]$sel0.selected.hwnd
$frozen = Restore-AmWindow $hwnd
Start-Sleep -Milliseconds 900
$sel = Select-Alpha1Target
$hwnd = [IntPtr][int64]$sel.selected.hwnd
$origRect = [Alpha1Native]::RectText($hwnd)
$recipe = [ordered]@{
  stamp = $stamp; at = (Get-Alpha1Iso); kind = 'stealth-soak'
  hwnd = [int64]$hwnd; originalExStyle = [int64][Alpha1Native]::ExStyle($hwnd)
  originalStyle = [int64][Alpha1Native]::Style($hwnd); originalLayered = [bool][Alpha1Native]::IsLayered($hwnd)
  originalAlpha = [int][Alpha1Native]::ReadAlpha($hwnd); originalRect = $origRect; preIconic = $preIconic
  addedLayered = $false; addedTransparent = $false; requestedAlpha = $Alpha
}
$recipePath = Write-Alpha1Recipe $stamp $recipe
Say ('# stealth soak ' + $stamp + '  minutes=' + $Minutes + ' interval=' + $IntervalSec + 's navEvery=' + $NavEverySec + 's resizes=' + $ResizeCount)
Say ('# frozenRestore=' + ($frozen | ConvertTo-Json -Compress))
Say ('# recipe=' + $recipePath)

# ---------------- sampling ----------------
# NOTE: do not name any local $h here - a [IntPtr] parameter $h would coerce it (PowerShell
# variables are case-insensitive and typed parameters re-coerce on assignment).
function Get-SoakPoints([IntPtr]$WinHandle) {
  $rt = [Alpha1Native]::RectText($WinHandle)
  $m = [regex]::Match($rt, '^(-?[0-9]+),(-?[0-9]+) ([0-9]+)x([0-9]+)$')
  $out = New-Object System.Collections.ArrayList
  if (-not $m.Success) { return @($out.ToArray()) }
  $rectX = [int]$m.Groups[1].Value; $rectY = [int]$m.Groups[2].Value
  $rectW = [int]$m.Groups[3].Value; $rectH = [int]$m.Groups[4].Value
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $mgn = 40
  $fx = @(0.08, 0.5, 0.92)
  $fy = @(0.08, 0.5, 0.92)
  foreach ($ry in $fy) {
    foreach ($rx in $fx) {
      $px = [int]($rectX + $rectW * $rx); $py = [int]($rectY + $rectH * $ry)
      if ($px -lt $vs.Left + $mgn -or $px -gt $vs.Left + $vs.Width - $mgn) { continue }
      if ($py -lt $vs.Top + $mgn -or $py -gt $vs.Top + $vs.Height - $mgn) { continue }
      [void]$out.Add(@{ x = $px; y = $py })
    }
  }
  return @($out.ToArray())
}

function Get-SoakSample([string]$Event, [string]$Perturb) {
  $ex = [Alpha1Native]::ExStyle($hwnd)
  $layered = (($ex -band [Alpha1Native]::WS_EX_LAYERED) -ne 0)
  $transparent = (($ex -band [Alpha1Native]::WS_EX_TRANSPARENT) -ne 0)
  $alpha = [int][Alpha1Native]::ReadAlpha($hwnd)
  $s = [ordered]@{
    t = Elapsed; at = (Get-Alpha1Iso); event = $Event; perturb = $Perturb
    hwnd = [int64]$hwnd; hwndHex = ('0x' + ('{0:X}' -f [int64]$hwnd))
    isWindow = [bool][Alpha1Native]::IsWindow($hwnd); hung = [bool][Alpha1Native]::IsHungAppWindow($hwnd)
    visible = [bool][Alpha1Native]::IsWindowVisible($hwnd); iconic = [bool][Alpha1Native]::IsIconic($hwnd)
    alpha = $alpha; exStyle = ('0x' + ('{0:X8}' -f $ex)); layered = $layered; transparent = $transparent
    stealthApplied = ($layered -and $transparent -and ($alpha -eq $Alpha))
    rect = [Alpha1Native]::RectText($hwnd); dpi = [Alpha1Native]::GetDpiForWindow($hwnd)
  }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $s['virtualScreen'] = ('' + $vs.Left + ',' + $vs.Top + ' ' + $vs.Width + 'x' + $vs.Height)
  $s['foregroundIsTarget'] = ([Alpha1Native]::GetForegroundWindow() -eq $hwnd)
  $uia = Get-Alpha1UiaRoot $hwnd 2 300
  $s['uiaRootOk'] = [bool]$uia.ok
  if ($uia.ok) {
    $c = Get-Alpha1UiaCounts $uia.root
    $s['descendants'] = [int]$c.descendants; $s['listItems'] = [int]$c.listItems; $s['buttons'] = [int]$c.buttons
    try { $s['treeSignature'] = Get-AmTreeSignature $uia.root } catch { $s['treeSignature'] = 'error' }
  } else { $s['descendants'] = -1; $s['listItems'] = -1; $s['treeSignature'] = '' }
  $sm = Get-AmSmtcState
  $s['smtcOk'] = [bool]$sm.ok; $s['smtcStatus'] = [string]$sm.status; $s['track'] = [string]$sm.title
  $s['artist'] = [string]$sm.artist; $s['pos'] = [string]$sm.pos; $s['dur'] = [string]$sm.dur; $s['posMs'] = [int64]$sm.posMs
  $pts = Get-SoakPoints $hwnd
  $amHits = 0; $detail = New-Object System.Collections.ArrayList
  foreach ($p in $pts) {
    $pt = New-Object Alpha1Native+POINT
    $pt.X = [int]$p.x; $pt.Y = [int]$p.y
    $hit = [Alpha1Native]::WindowFromPoint($pt)
    $root = [Alpha1Native]::GetAncestor($hit, 2)
    $isAm = ([int64]$root -eq [int64]$hwnd)
    if ($isAm) { $amHits++ }
    [void]$detail.Add(([string]$p.x + ',' + [string]$p.y + '=' + $(if ($isAm) { 'AM' } else { 'other' })))
  }
  $s['pointsTotal'] = [int]$pts.Count; $s['pointsStillAppleMusic'] = [int]$amHits
  $s['pointDetail'] = (@($detail.ToArray()) -join ';')
  return $s
}

function Test-SoakViolation($s, [int]$Requested) {
  $v = New-Object System.Collections.ArrayList
  if (-not $s.isWindow) { [void]$v.Add('isWindow=false') }
  if ([int]$s.alpha -ne $Requested) { [void]$v.Add('alpha=' + $s.alpha + ' expected=' + $Requested) }
  if (-not $s.layered) { [void]$v.Add('WS_EX_LAYERED lost') }
  if (-not $s.transparent) { [void]$v.Add('WS_EX_TRANSPARENT lost') }
  if (-not $s.uiaRootOk) { [void]$v.Add('UIA root unavailable') }
  if (-not $s.smtcOk) { [void]$v.Add('SMTC provider lost') }
  if ([int]$s.pointsStillAppleMusic -gt 0) { [void]$v.Add('WindowFromPoint hits Apple Music at ' + $s.pointsStillAppleMusic + '/' + $s.pointsTotal + ' points') }
  return @($v.ToArray())
}

$samples = 0; $violations = 0; $firstViolation = $null; $events = New-Object System.Collections.ArrayList
$uiaFailures = 0; $hungSamples = 0; $lastStatus = ''; $statusChanges = New-Object System.Collections.ArrayList
$alphaValues = New-Object System.Collections.ArrayList; $lostLayered = 0; $lostTransparent = 0; $amHitSamples = 0
$navCount = 0; $resizeDone = 0; $restoreRes = $null; $postSmtc = $null; $postUia = $null; $minRes = $null

try {
  $applyRes = Apply-Alpha1 $hwnd $Alpha
  $recipe['addedLayered'] = [bool]$applyRes.addedLayered
  $trans = Add-Alpha1Transparent $hwnd
  $recipe['addedTransparent'] = $true
  Write-Alpha1Recipe $stamp $recipe | Out-Null
  $applyRec = [ordered]@{ step = 'soak-apply'; at = (Get-Alpha1Iso); alpha = $applyRes; transparent = $trans; sample = (Get-Alpha1Sample $hwnd $Alpha) }
  Say ('[soak-apply] ' + ($applyRec | ConvertTo-Json -Compress -Depth 5))
  Append-Line ($applyRec | ConvertTo-Json -Compress -Depth 5)

  $totalSec = $Minutes * 60
  $nextNav = $NavEverySec
  # Resize schedule: ResizeCount evenly spaced events inside the run window (transparent).
  $resizeAt = New-Object System.Collections.ArrayList
  $rr = 1
  while ($rr -le $ResizeCount) {
    [void]$resizeAt.Add([int]($totalSec * $rr / ($ResizeCount + 1)))
    $rr++
  }
  $nextTick = 0
  Say ('# soak window: totalSec=' + $totalSec + ' elapsedAtStart=' + (Elapsed) + ' resizeAt=' + (@($resizeAt) -join ',') + ' firstNav=' + $nextNav)
  while ((Elapsed) -lt $totalSec) {
   try {
    $now = Elapsed
    # ---- perturbations ----
    $resizeDue = $false
    if ($resizeDone -lt $resizeAt.Count) { if ($now -ge [double]$resizeAt[$resizeDone]) { $resizeDue = $true } }
    if ($resizeDue) {
      $resizeDone++
      $b = Get-SoakSample 'resize-before' ('resize#' + $resizeDone)
      Append-Line ($b | ConvertTo-Json -Compress -Depth 5)
      [void][Alpha1Native]::ShowWindow($hwnd, [Alpha1Native]::SW_RESTORE)
      Start-Sleep -Milliseconds 700
      $f = [uint32]0x0004 -bor [uint32]0x0010
      [void][Alpha1Native]::SetWindowPos($hwnd, [IntPtr]::Zero, 200, 150, 1400, 900, $f)
      Start-Sleep -Milliseconds 900
      $a = Get-SoakSample 'resize-applied' ('resize#' + $resizeDone)
      Append-Line ($a | ConvertTo-Json -Compress -Depth 5)
      Start-Sleep -Seconds 2
      $holdS = Get-SoakSample 'resize-hold-2s' ('resize#' + $resizeDone)
      Append-Line ($holdS | ConvertTo-Json -Compress -Depth 5)
      [void][Alpha1Native]::ShowWindow($hwnd, [Alpha1Native]::SW_MAXIMIZE)
      Start-Sleep -Milliseconds 900
      $r = Get-SoakSample 'resize-restored' ('resize#' + $resizeDone)
      Append-Line ($r | ConvertTo-Json -Compress -Depth 5)
      [void]$events.Add(('resize#' + $resizeDone + '@' + $now))
    }
    if ($now -ge $nextNav -and $NavEverySec -gt 0) {
      $nextNav = $nextNav + $NavEverySec
      $navCount++
      $nb = Get-SoakSample 'nav-before' ('nav#' + $navCount)
      Append-Line ($nb | ConvertTo-Json -Compress -Depth 5)
      $uia = Get-Alpha1UiaRoot $hwnd 2 300
      if ($uia.ok) {
        $nav = Get-Alpha1NavItems $uia.root
        $selNav = ''
        foreach ($nv in $nav) { if ($nv.selected -and $selNav -eq '') { $selNav = [string]$nv.name } }
        $tgt = ''
        foreach ($nv in $nav) { if ($tgt -eq '' -and $nv.enabled -and ([string]$nv.name) -ne '' -and ([string]$nv.name) -ne $selNav) { $tgt = [string]$nv.name } }
        if ($tgt -ne '') {
          $res = Invoke-Alpha1NavSelect $uia.root $tgt
          Start-Sleep -Milliseconds 250
          $na = Get-SoakSample 'nav-applied' ('nav#' + $navCount + ' target=' + $tgt)
          Append-Line ($na | ConvertTo-Json -Compress -Depth 5)
          Start-Sleep -Seconds 2
          $n2 = Get-SoakSample 'nav-hold-2s' ('nav#' + $navCount)
          Append-Line ($n2 | ConvertTo-Json -Compress -Depth 5)
          [void]$events.Add(('nav#' + $navCount + '->' + $tgt + '@' + $now))
        }
      } else { [void]$events.Add(('nav#' + $navCount + ' skipped: UIA unavailable@' + $now)) }
    }
    # ---- regular tick ----
    $s = Get-SoakSample 'tick' ''
    $samples++
    [void]$alphaValues.Add([int]$s.alpha)
    if (-not $s.layered) { $lostLayered++ }
    if (-not $s.transparent) { $lostTransparent++ }
    if (-not $s.uiaRootOk) { $uiaFailures++ }
    if ($s.hung) { $hungSamples++ }
    if ([int]$s.pointsStillAppleMusic -gt 0) { $amHitSamples++ }
    if ($s.smtcStatus -ne $lastStatus) { [void]$statusChanges.Add(($lastStatus + '->' + $s.smtcStatus + '@' + $s.t)); $lastStatus = [string]$s.smtcStatus }
    $v = Test-SoakViolation $s $Alpha
    $s['violation'] = @($v)
    if ($v.Count -gt 0) {
      $violations++
      if (-not $firstViolation) {
        $firstViolation = [ordered]@{ t = $s.t; at = $s.at; reasons = @($v); snapshot = $s }
        Say ''
        Say 'VIOLATION'
        Say ('  t = ' + $s.at)
        Say ('  reasons = ' + (@($v) -join ' | '))
        Say ('  alpha: ' + $s.alpha + '  exStyle: ' + $s.exStyle + '  layered: ' + $s.layered + '  transparent: ' + $s.transparent)
        Say ('  UIA: ' + $(if ($s.uiaRootOk) { 'OK (' + $s.descendants + ' nodes)' } else { 'LOST' }) + '  SMTC: ' + $s.smtcStatus)
        Say ('  pointHits: ' + $s.pointsStillAppleMusic + '/' + $s.pointsTotal + ' AM')
        Say ('  event: ' + $s.event + ' ' + $s.perturb)
        Say ''
        Append-Line (([ordered]@{ step = 'VIOLATION-FIRST'; at = $s.at; t = $s.t; reasons = @($v); snapshot = $s }) | ConvertTo-Json -Compress -Depth 6)
      }
    }
    Append-Line ($s | ConvertTo-Json -Compress -Depth 6)
    if (($samples % 15) -eq 0) { Write-Host ('  t=' + $s.t + 's samples=' + $samples + ' alpha=' + $s.alpha + ' uia=' + $(if ($s.uiaRootOk) { $s.descendants } else { 'LOST' }) + ' smtc=' + $s.smtcStatus + ' amHits=' + $s.pointsStillAppleMusic + '/' + $s.pointsTotal + ' violations=' + $violations) }
   } catch {
    $err = [ordered]@{ step = 'soak-tick-error'; at = (Get-Alpha1Iso); t = (Elapsed); message = $_.Exception.Message }
    Say ('[soak-tick-error] ' + ($err | ConvertTo-Json -Compress))
    Append-Line ($err | ConvertTo-Json -Compress)
   }
    $nextTick = $nextTick + $IntervalSec
    $sleepMs = [int](($nextTick - (Elapsed)) * 1000)
    if ($sleepMs -gt 50) { Start-Sleep -Milliseconds $sleepMs } else { Start-Sleep -Milliseconds 100; $nextTick = [int](Elapsed) }
  }
} finally {
  $restoreRes = Restore-Alpha1 $hwnd $recipe -SkipMinimize
}

Say ('[soak-restore] ' + ($restoreRes | ConvertTo-Json -Compress))
Start-Sleep -Milliseconds 900
$postUia = Get-Alpha1UiaRoot $hwnd
$postSample = Get-Alpha1Sample $hwnd 255
$postSmtc = Get-AmSmtcState
Say ('[soak-postrestore] ' + ([ordered]@{ sample = $postSample; uiaOk = $postUia.ok; uiaName = $postUia.name; smtc = $postSmtc } | ConvertTo-Json -Compress -Depth 4))
if ($recipe.preIconic) { $minRes = Set-Alpha1WindowMinimized $hwnd; Say ('[soak-minimize] ' + ($minRes | ConvertTo-Json -Compress -Depth 4)) }

$alphaMin = if ($alphaValues.Count -gt 0) { ($alphaValues | Measure-Object -Minimum).Minimum } else { -1 }
$alphaMax = if ($alphaValues.Count -gt 0) { ($alphaValues | Measure-Object -Maximum).Maximum } else { -1 }
$verdict = if ($violations -eq 0) { 'NO_VIOLATION' } else { 'VIOLATION_OBSERVED' }
$summary = [ordered]@{
  stamp = $stamp; kind = 'stealth-soak'; minutes = $Minutes; intervalSec = $IntervalSec
  navEverySec = $NavEverySec; resizesDone = $resizeDone; sampleCount = $samples
  verdict = $verdict; violations = $violations; firstViolation = $firstViolation
  alphaMin = $alphaMin; alphaMax = $alphaMax; lostLayered = $lostLayered; lostTransparent = $lostTransparent
  uiaFailureSamples = $uiaFailures; hungSamples = $hungSamples; amHitSamples = $amHitSamples
  statusChanges = @($statusChanges.ToArray()); perturbations = @($events.ToArray())
  restore = $restoreRes; postRestore = [ordered]@{ uiaOk = $postUia.ok; alpha = $postSample.observedAlpha; layered = $postSample.layered; transparent = $postSample.transparent; smtc = $postSmtc.status }
  recipePath = $recipePath
}
Say ('[soak-summary] ' + ($summary | ConvertTo-Json -Compress -Depth 6))
Append-Line (([ordered]@{ step = 'summary'; summary = $summary }) | ConvertTo-Json -Compress -Depth 8)
Set-Content -Path $txtPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $sumPath -Encoding UTF8
Write-Host ''
Write-Host ('soak done: verdict=' + $verdict + ' samples=' + $samples + ' violations=' + $violations)
Write-Host ('reports: ' + $txtPath)
Write-Host ('         ' + $jsonlPath)
Write-Host ('         ' + $sumPath)