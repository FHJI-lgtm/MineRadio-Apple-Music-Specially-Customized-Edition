# T-E2: READ-ONLY inventory of Apple Music local data/cache/logs, then a bounded token search.
# Explicitly skips credentials/cookies/tokens/personal content files.
param([string]$TokensFile, [string]$OutFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$t = Get-Content $TokensFile -Raw -Encoding UTF8 | ConvertFrom-Json
$o = [ordered]@{ stage = 'INVENTORY'; roots = @(); candidates = @(); hits = @(); verdict = ''; notes = @() }
$skipPattern = 'credential|cookie|login data|token|keychain|password|session'
$roots = @()
$pkgRoot = Join-Path $env:LOCALAPPDATA 'Packages\AppleInc.AppleMusicWin_nzyj5cx40ttqa'
if (Test-Path $pkgRoot) { $roots += $pkgRoot }
foreach ($extra in @('Apple Music','Apple','AppleInc')) { $p = Join-Path $env:LOCALAPPDATA $extra; if (Test-Path $p) { $roots += $p } }
$o.roots = @($roots)
$files = @()
foreach ($r in $roots) {
  try {
    $files += Get-ChildItem -Path $r -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 -and $_.Length -lt 300MB }
  } catch { }
}
$o.candidateCount = @($files).Count
$o.byExtension = @($files | Group-Object Extension | Sort-Object Count -Descending | Select-Object -First 12 | ForEach-Object { $_.Name + ':' + $_.Count })
$o.candidates = @($files | Where-Object { $_.Extension -match '^\.(db|sqlite|sqlite3|plist|log|txt|json|dat|bin)$' } | Sort-Object Length -Descending | Select-Object -First 40 | ForEach-Object { @{ path = $_.FullName; size = $_.Length; ext = $_.Extension } })
$scanned = 0
foreach ($f in $o.candidates) {
  if ($f.path -match $skipPattern) { $o.notes += ('skipped (sensitive-looking): ' + $f.path); continue }
  $text = ''
  try { $bytes = [System.IO.File]::ReadAllBytes($f.path); if ($bytes.Length -gt 60MB) { continue } ; $text = [System.Text.Encoding]::UTF8.GetString($bytes) } catch { continue }
  $scanned++
  $pHits = @() ; $hHits = @()
  foreach ($p in $t.pids) { if ($text.IndexOf([string]$p) -ge 0) { $pHits += [string]$p } }
  foreach ($h in $t.pidsHex) { if ($text.IndexOf([string]$h) -ge 0) { $hHits += [string]$h } }
  if ($pHits.Count -gt 0 -or $hHits.Count -gt 0) {
    $o.hits += @{ path = $f.path; pIdsFound = @($pHits); pidHexFound = @($hHits); sameFile = ($pHits.Count -gt 0 -and $hHits.Count -gt 0) }
  }
}
$o.scanned = $scanned
$both = @($o.hits | Where-Object { $_.sameFile })
if ($both.Count -gt 0) { $o.verdict = 'T-E2 NEEDS-REVIEW' } else { $o.verdict = 'T-E2 FAIL' }
$o.stage = 'DONE'
$json = ($o | ConvertTo-Json -Compress -Depth 8)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json