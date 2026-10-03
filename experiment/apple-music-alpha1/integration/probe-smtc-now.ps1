$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib\am-common.ps1'
. 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib\am-smtc.ps1'
$s = Get-AmSmtcState
$s | ConvertTo-Json -Compress -Depth 4