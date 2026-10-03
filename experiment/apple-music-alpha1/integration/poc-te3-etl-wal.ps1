param([string]$TokensFile, [string]$OutFile, [string]$TmpDir)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $t = Get-Content $TokensFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $out = [ordered]@{ stage = 'SCAN'; etl = @(); sqlite = @(); decodeOk = 0; decodeFail = 0; coOccurrence = @(); verdict = ''; notes = @() }
  $roots = @()
  $a = Join-Path $env:LOCALAPPDATA 'Packages\AppleInc.AppleMusicWin_nzyj5cx40ttqa'; if (Test-Path $a) { $roots += $a }
  $b = Join-Path $env:LOCALAPPDATA 'Apple'; if (Test-Path $b) { $roots += $b }
  $files = @()
  foreach ($r in $roots) { try { $files += Get-ChildItem -Path $r -Recurse -File -ErrorAction SilentlyContinue } catch { } }
  $etls = @($files | Where-Object { $_.Extension -eq '.etl' })
  $sqls = @($files | Where-Object { $_.Name -like '*.sqlite*' })
  function Find-Tokens([string]$path) {
    $res = @{ p = @(); h = @(); size = 0 }
    try {
      $fi = Get-Item $path -ErrorAction Stop
      if ($fi.Length -gt 300MB) { return $res }
      $res.size = $fi.Length
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $txt = [System.Text.Encoding]::ASCII.GetString($bytes)
      foreach ($x in $t.pids) { if ($txt.IndexOf([string]$x) -ge 0) { $res.p += [string]$x } }
      foreach ($x in $t.pidsHex) { if ($x -ne '0x0' -and $txt.IndexOf([string]$x) -ge 0) { $res.h += [string]$x } }
    } catch { }
    return $res
  }
  foreach ($f in $etls) {
    $row = [ordered]@{ file = $f.Name; size = $f.Length; mtime = $f.LastWriteTime.ToString('s'); decoded = $false; decodeMsg = ''; p = @(); h = @() }
    $r1 = Find-Tokens $f.FullName; $row.p = $r1.p; $row.h = $r1.h
    if ($f.Length -lt 50MB -and $TmpDir) {
      $dst = Join-Path $TmpDir ($f.BaseName + '.xml')
      try {
        & tracerpt.exe "$($f.FullName)" -o "$dst" -of XML -y *> $null
        if ($LASTEXITCODE -eq 0 -and (Test-Path $dst)) { $row.decoded = $true; $out.decodeOk++ ; $r2 = Find-Tokens $dst; $row.p = @($row.p + $r2.p | Sort-Object -Unique); $row.h = @($row.h + $r2.h | Sort-Object -Unique); $row.decodeMsg = 'tracerpt ok' }
        else { $out.decodeFail++ ; $row.decodeMsg = ('tracerpt exit=' + $LASTEXITCODE) }
      } catch { $out.decodeFail++ ; $row.decodeMsg = ('tracerpt error: ' + $_.Exception.Message) }
    } else { $row.decodeMsg = 'skipped (>=50MB)' }
    if ($row.p.Count -gt 0 -and $row.h.Count -gt 0) { $out.coOccurrence += $f.Name }
    $out.etl += $row
  }
  foreach ($f in $sqls) {
    $r = Find-Tokens $f.FullName
    $out.sqlite += [ordered]@{ file = $f.Name; size = $f.Length; mtime = $f.LastWriteTime.ToString('s'); p = @($r.p); h = @($r.h) }
    if ($r.p.Count -gt 0 -and $r.h.Count -gt 0) { $out.coOccurrence += $f.Name }
  }
  $out.stage = 'DONE'
  if ($out.coOccurrence.Count -gt 0) { $out.verdict = 'T-E3 NEEDS-REVIEW' } else { $out.verdict = 'T-E3 FAIL' }
  $json = ($out | ConvertTo-Json -Compress -Depth 8)
  $json | Out-File -FilePath $OutFile -Encoding utf8
  Write-Output $json
} catch {
  Write-Output ('{"stage":"ERROR","message":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}