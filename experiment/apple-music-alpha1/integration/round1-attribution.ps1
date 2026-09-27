# ============================================================
# experiment/apple-music-alpha1/integration/round1-attribution.ps1
# Round-1 attribution: does MineRadio's AMC play chain survive the stealth layer, and WHICH layer
# breaks it? Three phases, each running the real chain via integration/amc-chain-driver.js:
#   A  stealth OFF  (alpha 255, no styles)          -> control
#   B  alpha=1 only (WS_EX_LAYERED + LWA_ALPHA)     -> isolate click-through
#   C  alpha=1 + WS_EX_TRANSPARENT                  -> the stealth candidate
# Ends by restoring the window (alpha 255, original exStyle, SW_MINIMIZE).
# ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [string]$Driver = 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration\amc-chain-driver.js',
  [string]$OutDir = 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration'
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repo = 'F:\mineradio-apple-music'
$pocLib = Join-Path $repo 'experiment\apple-music-windows-control\poc\lib'
. (Join-Path $pocLib 'am-common.ps1')
. (Join-Path $pocLib 'am-smtc.ps1')
. (Join-Path $pocLib 'am-uia.ps1')
. (Join-Path $repo 'experiment\apple-music-alpha1\lib\alpha-common.ps1')

$results = New-Object System.Collections.ArrayList
function Get-ChainLogTail([string]$LogFile, [int]$Lines = 4) {
  if (-not $LogFile -or -not (Test-Path $LogFile)) { return @() }
  return @(Get-Content $LogFile -Tail $Lines -ErrorAction SilentlyContinue)
}
function Run-Phase([string]$Name, [string]$Term, [string]$OutFile, [string]$Expectation, [string]$LogFile) {
  $before = Get-AmSmtcState
  $logBefore = Get-ChainLogTail $LogFile 30
  $out = & node $Driver $Term $OutFile 2>&1
  Start-Sleep -Seconds 4
  $after = Get-AmSmtcState
  $state = Get-Alpha1Sample $script:hwnd 255
  $json = $null
  try { $json = Get-Content $OutFile -Raw | ConvertFrom-Json } catch { }
  $logAfter = Get-ChainLogTail $LogFile 12
  $rec = [ordered]@{
    phase = $Name; expectation = $Expectation; term = $Term
    chainStdout = (@($out) -join ' | ')
    search = $json.steps.search; play = $json.steps.play
    smtcBefore = [ordered]@{ title = [string]$before.title; artist = [string]$before.artist; status = [string]$before.status }
    smtcAfter = [ordered]@{ title = [string]$after.title; artist = [string]$after.artist; status = [string]$after.status }
    trackChanged = ([string]$before.title -ne [string]$after.title)
    windowState = [ordered]@{ alpha = $state.observedAlpha; exStyle = $state.exStyle; layered = $state.layered; transparent = $state.transparent; iconic = $state.iconic }
    appLog = [ordered]@{ before = @($logBefore); after = @($logAfter) }
  }
  [void]$results.Add($rec)
  Write-Host ('[' + $Name + '] trackChanged=' + $rec.trackChanged + ' play=' + ($json.steps.play | ConvertTo-Json -Compress))
  return $rec
}

$sel0 = Select-Alpha1Target
if (-not $sel0.selected) { Write-Host 'FATAL: no Apple Music window'; exit 3 }
$preIconic = [bool]$sel0.selected.iconic
$frozen = Restore-AmWindow ([IntPtr][int64]$sel0.selected.hwnd)
Start-Sleep -Milliseconds 900
$sel = Select-Alpha1Target
$script:hwnd = [IntPtr][int64]$sel.selected.hwnd
$logFile = (Get-ChildItem $OutDir -Filter 'mineradio-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
Write-Host ('window=' + $script:hwnd + ' appLog=' + $logFile)
$recipe = [ordered]@{ stamp = (Get-Alpha1Stamp); hwnd = [int64]$script:hwnd
  originalExStyle = [int64][Alpha1Native]::ExStyle($script:hwnd); originalStyle = [int64][Alpha1Native]::Style($script:hwnd)
  originalLayered = [bool][Alpha1Native]::IsLayered($script:hwnd); originalAlpha = [int][Alpha1Native]::ReadAlpha($script:hwnd)
  preIconic = $preIconic; addedLayered = $false; addedTransparent = $false; requestedAlpha = 1 }
Write-Alpha1Recipe $recipe.stamp $recipe | Out-Null

try {
  Run-Phase 'A-stealth-off' 'Blinding Lights' (Join-Path $OutDir 'amc-phase-A.json') 'chain works normally with no stealth' $logFile | Out-Null
  Start-Sleep -Seconds 3
  $applyA = Apply-Alpha1 $script:hwnd 1
  $recipe['addedLayered'] = [bool]$applyA.addedLayered
  Write-Alpha1Recipe $recipe.stamp $recipe | Out-Null
  Write-Host ('[B] alpha=1 applied: ' + ($applyA | ConvertTo-Json -Compress))
  Run-Phase 'B-alpha-only' 'Levitating' (Join-Path $OutDir 'amc-phase-B.json') 'chain works with Alpha=1 (no transparent)' $logFile | Out-Null
  Start-Sleep -Seconds 3
  $trans = Add-Alpha1Transparent $script:hwnd
  $recipe['addedTransparent'] = $true
  Write-Alpha1Recipe $recipe.stamp $recipe | Out-Null
  Write-Host ('[C] transparent added: ' + ($trans | ConvertTo-Json -Compress))
  Run-Phase 'C-alpha-plus-transparent' 'Save Your Tears' (Join-Path $OutDir 'amc-phase-C.json') 'chain expected to FAIL: synthesized clicks pass through' $logFile | Out-Null
} finally {
  $restoreRes = Restore-Alpha1 $script:hwnd $recipe -SkipMinimize
}

$summary = [ordered]@{ at = (Get-Alpha1Iso); driver = $Driver; logFile = $logFile; frozenRestore = $frozen; restore = $restoreRes; phases = @($results.ToArray()) }
$sumFile = Join-Path $OutDir 'round1-attribution-summary.json'
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $sumFile -Encoding UTF8
Write-Host ''
Write-Host ('summary: ' + $sumFile)
Write-Host ('A/B/C trackChanged = ' + ((@($results.ToArray()) | ForEach-Object { $_.phase + '=' + $_.trackChanged }) -join ', '))
if ($recipe.preIconic) { $m = Set-Alpha1WindowMinimized $script:hwnd; Write-Host ('minimized=' + $m.minimized) }