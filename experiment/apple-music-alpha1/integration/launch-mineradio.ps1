# Launch MineRadio (dev) with a clean Electron env and stdout/stderr captured to a log file,
# so the main-process evidence chain ([AUDIO] metrics, SMTC bridge, thumbnail resolution)
# stays readable during the integration test.
param(
  [string]$AppRoot = 'F:\mineradio-apple-music',
  [string]$LogDir = 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration',
  [string]$ExtraArgs = ''
)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$log = Join-Path $LogDir ('mineradio-' + $stamp + '.log')
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Write-Host ('log: ' + $log)
Set-Location $AppRoot
$args2 = @()
if ($ExtraArgs -ne '') { $args2 = @($ExtraArgs) }
$args2 += '.'
Write-Host ('electron args: ' + ($args2 -join ' '))
& (Join-Path $AppRoot 'node_modules\electron\dist\electron.exe') @args2 *>&1 | Tee-Object -FilePath $log
Write-Host ('electron exited: ' + $LASTEXITCODE)