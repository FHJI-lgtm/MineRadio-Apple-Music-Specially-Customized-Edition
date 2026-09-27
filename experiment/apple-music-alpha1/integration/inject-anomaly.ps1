# Inject one window-state anomaly into the Apple Music main window (Round 4 watchdog smoke).
# Read/write only on the Apple Music window: it never touches MineRadio or poc/lib.
param([Parameter(Mandatory=$true)][ValidateSet('alpha255','clearTransparent','clearLayered','both','minimize','restore')][string]$Mode)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repo = 'F:\mineradio-apple-music'
. (Join-Path $repo 'experiment\apple-music-alpha1\lib\alpha-common.ps1')
$sel = Select-Alpha1Target
if (-not $sel.selected) { Write-Output 'NO_TARGET'; exit 3 }
$h = [IntPtr][int64]$sel.selected.hwnd
$before = Get-Alpha1Sample $h 1
$ex = [Alpha1Native]::ExStyle($h)
if ($Mode -eq 'alpha255') { [void][Alpha1Native]::SetLayeredWindowAttributes($h, 0, [byte]255, [Alpha1Native]::LWA_ALPHA) }
elseif ($Mode -eq 'clearTransparent') { [void][Alpha1Native]::SetWindowLongPtr($h, [Alpha1Native]::GWL_EXSTYLE, [IntPtr][int64]($ex -band (-bnot [int64][Alpha1Native]::WS_EX_TRANSPARENT))) }
elseif ($Mode -eq 'clearLayered') { [void][Alpha1Native]::SetWindowLongPtr($h, [Alpha1Native]::GWL_EXSTYLE, [IntPtr][int64]($ex -band (-bnot [int64][Alpha1Native]::WS_EX_LAYERED))) }
elseif ($Mode -eq 'minimize') { [void][Alpha1Native]::ShowWindow($h, [Alpha1Native]::SW_MINIMIZE) }
elseif ($Mode -eq 'restore') { [void][Alpha1Native]::ShowWindow($h, [Alpha1Native]::SW_RESTORE) }
elseif ($Mode -eq 'both') { [void][Alpha1Native]::SetWindowLongPtr($h, [Alpha1Native]::GWL_EXSTYLE, [IntPtr][int64]($ex -band (-bnot [int64]([Alpha1Native]::WS_EX_LAYERED -bor [Alpha1Native]::WS_EX_TRANSPARENT)))) }
Start-Sleep -Milliseconds 300
$after = Get-Alpha1Sample $h 1
$out = [ordered]@{ mode = $Mode; at = (Get-Alpha1Iso); hwnd = [int64]$h; before = [ordered]@{ alpha = $before.observedAlpha; exStyle = $before.exStyle; layered = $before.layered; transparent = $before.transparent }; after = [ordered]@{ alpha = $after.observedAlpha; exStyle = $after.exStyle; layered = $after.layered; transparent = $after.transparent } }
Write-Output ($out | ConvertTo-Json -Compress)