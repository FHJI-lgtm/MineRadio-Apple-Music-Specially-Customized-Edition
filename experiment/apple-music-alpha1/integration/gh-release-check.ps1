[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$h = @{ Authorization = ('Bearer ' + $env:GH_TOKEN); Accept = 'application/vnd.github+json'; 'User-Agent' = 'mineradio-check' }
$r = Invoke-RestMethod -Method Get -Uri 'https://api.github.com/repos/FHJI-lgtm/MineRadio-Apple-Music-Specially-Customized-Edition/releases/397520090' -Headers $h -TimeoutSec 60
Write-Output ('tag=' + $r.tag_name + ' name=' + $r.name + ' prerelease=' + $r.prerelease + ' draft=' + $r.draft)
Write-Output ('url=' + $r.html_url)
Write-Output ('assets=' + $r.assets.Count)
foreach ($a in $r.assets) { Write-Output ('  - ' + $a.name + '  ' + [math]::Round($a.size/1MB,1) + ' MB  downloads=' + $a.download_count) }
Write-Output ('body chars=' + $r.body.Length)