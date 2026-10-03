# ASCII-only on purpose: PS 5.1 reads BOM-less UTF-8 .ps1 as ANSI, so all Chinese text comes
# from UTF-8 files read with IO.File.ReadAllText(..., UTF8).
param(
  [string]$Repo = 'FHJI-lgtm/MineRadio-Apple-Music-Specially-Customized-Edition',
  [int]$Id = 397520090,
  [string]$NotesFile = 'F:\mineradio-apple-music\dist\RELEASE-NOTES-2.0.0-beta.1.md',
  [string]$NameFile = 'F:\mineradio-apple-music\dist\RELEASE-NAME-2.0.0-beta.1.txt'
)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$h = @{ Authorization = ('Bearer ' + $env:GH_TOKEN); Accept = 'application/vnd.github+json'; 'User-Agent' = 'mineradio-release'; 'Content-Type' = 'application/json; charset=utf-8' }
$text = [System.IO.File]::ReadAllText($NotesFile, [System.Text.Encoding]::UTF8)
$name = ([System.IO.File]::ReadAllText($NameFile, [System.Text.Encoding]::UTF8)).Trim()
$json = ([ordered]@{ name = $name; body = $text; prerelease = $true; draft = $false } | ConvertTo-Json -Depth 4)
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
try {
  $r = Invoke-RestMethod -Method Patch -Uri ('https://api.github.com/repos/' + $Repo + '/releases/' + $Id) -Headers $h -Body $bytes -TimeoutSec 120
  Write-Output ('updated: prerelease=' + $r.prerelease + ' bodyChars=' + $r.body.Length + ' assets=' + $r.assets.Count)
  Write-Output ('url=' + $r.html_url)
  Write-Output ('title=' + $r.name)
  Write-Output ('firstLine=' + ($r.body -split "`n")[0])
} catch { $m = $_.Exception.Message; try { if ($_.ErrorDetails.Message) { $m += ' | body=' + $_.ErrorDetails.Message } } catch {}; Write-Output ('PATCH failed: ' + $m) }