$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
. (Join-Path $lib 'am-uia.ps1')
$id = Get-Content 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration\poc-playlist-identity.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$t = $id.tracks[0]
$o = [ordered]@{ catalogId = [string]$t.catalogId; expectTitle = [string]$t.name; before = ''; url = ''; method = ''; after = ''; ok = $false }
$sb = Get-AmSmtcState; $o.before = ([string]$sb.status + '|' + [string]$sb.title)
$url = 'https://music.apple.com/us/song/' + $t.catalogId
$o.url = $url
$nav = Invoke-AmNavigateUrl $url
$o.method = [string]$nav.method
Start-Sleep -Seconds 12
$sa = Get-AmSmtcState
$o.after = ([string]$sa.status + '|' + [string]$sa.title + '|' + [string]$sa.artist)
$o.ok = ([string]$sa.title -eq [string]$t.name)
$o | ConvertTo-Json -Compress -Depth 5 | Write-Output