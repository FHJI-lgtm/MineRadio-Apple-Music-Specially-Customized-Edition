param(
  [string]$Repo = 'FHJI-lgtm/MineRadio-Apple-Music-Specially-Customized-Edition',
  [string]$Tag = 'v2.0.0-beta.1',
  [string]$NotesFile = 'F:\mineradio-apple-music\dist\RELEASE-NOTES-2.0.0-beta.1.md',
  [string]$Assets = ''   # paths joined with | (avoids PowerShell array-binding surprises)
)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ Authorization = ('Bearer ' + $env:GH_TOKEN); Accept = 'application/vnd.github+json'; 'User-Agent' = 'mineradio-release' }
$jsonHeaders = @{ Authorization = ('Bearer ' + $env:GH_TOKEN); Accept = 'application/vnd.github+json'; 'User-Agent' = 'mineradio-release'; 'Content-Type' = 'application/json; charset=utf-8' }
function Show-Error($label, $err) {
  $msg = $err.Exception.Message
  try { if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $msg = $msg + ' | body=' + $err.ErrorDetails.Message } } catch { }
  Write-Output ($label + ' -> ' + $msg)
}
# diagnosis (read-only)
try { $u = Invoke-RestMethod -Method Get -Uri 'https://api.github.com/user' -Headers $headers -TimeoutSec 60; Write-Output ('token user: ' + $u.login) } catch { Show-Error 'GET /user' $_ }
try { $rp = Invoke-WebRequest -Method Get -Uri ('https://api.github.com/repos/' + $Repo) -Headers $headers -TimeoutSec 60; Write-Output ('repo ok, push=' + (($rp.Content | ConvertFrom-Json).permissions.push)) } catch { Show-Error 'GET repo' $_ }
# create the release with an explicitly UTF-8 encoded body
$notesText = [System.IO.File]::ReadAllText($NotesFile, [System.Text.Encoding]::UTF8)   # PS 5.1 Get-Content would read UTF-8 as GBK and mangle the notes
$bodyObj = [ordered]@{ tag_name = $Tag; name = ($Tag + ' - Apple Music stealth mode + watchdog'); body = $notesText; prerelease = $true; draft = $false }
$json = $bodyObj | ConvertTo-Json -Depth 4
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$rel = $null
try {
  Write-Output ('body preview: ' + $json.Substring(0, [Math]::Min(60, $json.Length)))
  $rel = Invoke-RestMethod -Method Post -Uri ('https://api.github.com/repos/' + $Repo + '/releases') -Headers $jsonHeaders -Body $bytes -TimeoutSec 120
  Write-Output ('created release id=' + $rel.id)
} catch { Show-Error 'POST release' $_ }
if (-not $rel) { try { $rel = Invoke-RestMethod -Method Get -Uri ('https://api.github.com/repos/' + $Repo + '/releases/tags/' + $Tag) -Headers $headers -TimeoutSec 60; Write-Output ('existing release id=' + $rel.id) } catch { Show-Error 'GET release by tag' $_ } }
if (-not $rel) { Write-Output 'ABORT: no release'; exit 2 }
Write-Output ('release url: ' + $rel.html_url + ' prerelease=' + $rel.prerelease)
$assetList = @($Assets -split '[|;]' | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_.Trim() })
foreach ($a in $assetList) {
  if (-not (Test-Path $a)) { Write-Output ('missing asset ' + $a); continue }
  $name = [System.IO.Path]::GetFileName($a)
  Write-Output ('uploading ' + $name + ' (' + [math]::Round((Get-Item $a).Length / 1MB, 1) + ' MB) ...')
  try {
    $up = Invoke-RestMethod -Method Post -Uri ('https://uploads.github.com/repos/' + $Repo + '/releases/' + $rel.id + '/assets?name=' + [uri]::EscapeDataString($name)) -Headers $headers -InFile $a -ContentType 'application/octet-stream' -TimeoutSec 2400
    Write-Output ('  ok: ' + $up.name + ' ' + [math]::Round($up.size / 1MB, 1) + ' MB ' + $up.browser_download_url)
  } catch { Show-Error ('upload ' + $name) $_ }
}
$assets = Invoke-RestMethod -Method Get -Uri ('https://api.github.com/repos/' + $Repo + '/releases/' + $rel.id + '/assets') -Headers $headers -TimeoutSec 60
Write-Output ('assets now on the release: ' + (($assets | ForEach-Object { $_.name + '(' + [math]::Round($_.size/1MB,1) + 'MB)' }) -join ', '))