# Parse-check every .ps1 in this experiment folder (no execution, no state change).
param([string]$Root = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Continue'
$bad = 0
Get-ChildItem -Path $Root -Recurse -Filter *.ps1 -File | Sort-Object FullName | ForEach-Object {
  $errs = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$errs)
  if ($errs -and $errs.Count -gt 0) {
    $bad++
    Write-Host ('FAIL ' + $_.FullName)
    foreach ($e in $errs) { Write-Host ('     line ' + $e.Extent.StartLineNumber + ': ' + $e.Message) }
  } else {
    Write-Host ('OK   ' + $_.Name)
  }
}
if ($bad -eq 0) { Write-Host 'ALL_PS1_PARSE_OK' } else { Write-Host ('PARSE_FAILURES=' + $bad) }
