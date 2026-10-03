# T0: rebuild the verified baseline with a fixture URL taken verbatim, and record SMTC BEFORE/AFTER.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
. (Join-Path $lib 'am-uia.ps1')
$url = ([System.IO.File]::ReadAllText('F:\mineradio-apple-music\experiment\apple-music-alpha1\integration\poc-t0-url.txt', [System.Text.Encoding]::UTF8)).Trim()
$b = Get-AmSmtcState
$o = [ordered]@{ test = 'T0'; url = $url; before = @{ status = [string]$b.status; title = [string]$b.title; artist = [string]$b.artist }; method = ''; navigated = $null; after = @{}; elapsedMs = 0 }
$sw = [Diagnostics.Stopwatch]::StartNew()
$nav = Invoke-AmNavigateUrl $url
$o.method = [string]$nav.method
Start-Sleep -Seconds 14
$a = Get-AmSmtcState
$o.after = @{ status = [string]$a.status; title = [string]$a.title; artist = [string]$a.artist; posMs = $a.posMs; dur = [string]$a.dur }
$o.elapsedMs = [int]$sw.ElapsedMilliseconds
$o | ConvertTo-Json -Compress -Depth 6 | Write-Output