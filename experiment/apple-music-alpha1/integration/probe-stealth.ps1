# Ground-truth read of the Apple Music window's stealth properties (read-only).
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repo = 'F:\mineradio-apple-music'
. (Join-Path $repo 'experiment\apple-music-alpha1\lib\alpha-common.ps1')
$sel = Select-Alpha1Target
if (-not $sel.selected) { Write-Output 'NO_TARGET'; exit 3 }
$h = [IntPtr][int64]$sel.selected.hwnd
$s = Get-Alpha1Sample $h 1
Write-Output (([ordered]@{ hwnd = [int64]$h; alpha = $s.observedAlpha; exStyle = $s.exStyle; layered = $s.layered; transparent = $s.transparent; iconic = $s.iconic; title = [Alpha1Native]::Title($h) }) | ConvertTo-Json -Compress)