# ============================================================
# poc/analyze-e2e.ps1
# Post-hoc audit of an E2E jsonl run. Recomputes the two metrics whose first
# implementation was buggy: artist identity with the CORRECT argument order of
# Test-AmSmtcArtistMatch(smtcArtist, targetArtist), and the requested-album
# layer via Get-AmAlbumLayer(...).layer (it returns a hashtable, not an int).
# Read-only: never re-runs playback and never calls the network.
# ============================================================
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Jsonl)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\am-common.ps1')
. (Join-Path $PSScriptRoot '..\phase3-resolve\lib\resolve35.ps1')

$rows = @(Get-Content -Path $Jsonl -Encoding UTF8 | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_ | ConvertFrom-Json })
$wa = 0; $al0 = 0; $smtcBad = 0
foreach ($r in $rows) {
  $sm = -1
  if (('' + $r.smtcArtist) -ne '') { $sm = [int](Test-AmSmtcArtistMatch ('' + $r.smtcArtist) ('' + $r.artist)) }
  $al = -1
  if (('' + $r.album) -ne '' -and ('' + $r.matchedAlbum) -ne '') { $al = [int]((Get-AmAlbumLayer ('' + $r.album) ('' + $r.matchedAlbum)).layer) }
  $as = -1
  if ($r.artistLayer -is [hashtable] -or $r.artistLayer.score -ne $null) { $as = [int]$r.artistLayer.score }
  $wrong = $false
  if ($r.resolveOk -and ('' + $r.artist) -ne '' -and ($as -eq 0 -or ($r.playback -eq 'OK' -and $sm -eq 0))) { $wrong = $true; $wa++ }
  if ($sm -eq 0) { $smtcBad++ }
  if ($al -eq 0) { $al0++ }
  Write-Host (('{0,-4} conf={1,-9} resolveOk={2,-5} artistScore={3,-3} smtcArtistMatch={4,-3} reqAlbumLayer={5,-3} wrongArtist={6,-5} stage={7}' -f $r.id, $r.confidence, $r.resolveOk, $as, $sm, $al, $wrong, $r.stage))
}
Write-Host ''
Write-Host ('TOTAL cases=' + $rows.Count)
Write-Host ('WRONG_ARTIST_ACCEPTANCES=' + $wa)
Write-Host ('SMTC_ARTIST_MISMATCH=' + $smtcBad)
Write-Host ('REQUESTED_ALBUM_LAYER_0=' + $al0)
$code = @{}
foreach ($r in $rows) { if (-not $code.ContainsKey($r.code)) { $code[$r.code] = 0 }; $code[$r.code]++ }
$parts = @(); foreach ($k in ($code.Keys | Sort-Object)) { $parts += ($k + '=' + $code[$k]) }
Write-Host ('REFUSAL_CODES: ' + ($parts -join ', '))
