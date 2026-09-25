# ============================================================
# phase3.7A-navigation/run-e10.ps1
# Entry point for the E10 navigation investigation.
#
#   .\run-e10.ps1 -Title "Someone Like You" -Artist "Adele" -SongId "403037927" `
#                 -Url "https://music.apple.com/cn/song/someone-like-you/403037927"
#
# Options:
#   -Cases CTRL-A,CTRL-C,E10-D1   run only these cases
#   -Full                        full 9-point timeline (T+0..T+12000) for every case
#   -NoPrepare                   do not pre-navigate (app state axis F2)
#   -List                        only print the available cases
#
# Nothing under poc/lib is loaded or modified; the frozen playback path stays frozen.
# ASCII-only.
# ============================================================
[CmdletBinding()]
param(
  [string]$Title = '',
  [string]$Artist = '',
  [string]$SongId = '',
  [string]$Url = '',
  [string[]]$Cases = @(),
  [switch]$Full,
  [switch]$NoPrepare,
  [switch]$List
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\nav-experiment.ps1')

$casePath = Join-Path $PSScriptRoot 'cases\E10.json'
$data = Get-Content -Path $casePath -Raw -Encoding UTF8 | ConvertFrom-Json

# CLI overrides so the entry point accepts the documented parameters
if ($Title -ne '') { $data.target.title = $Title }
if ($Artist -ne '') { $data.target.artist = $Artist }
if ($SongId -ne '') { $data.target.songId = $SongId }
if ($Url -ne '') {
  $data.target.canonicalUrl = $Url
  foreach ($v in $data.target.urlVariants) { if ($v.kind -eq 'cn-canonical') { $v.url = $Url } }
  foreach ($v in $data.target.invocationVariants) { $v.url = $Url }
}

if ($List) {
  Write-Host 'controls:'
  foreach ($c in $data.controls) { Write-Host ('  CTRL-' + $c.id + '  ' + $c.title + ' / ' + $c.artist + '  -> ' + $c.url) }
  Write-Host 'E10 url/storefront cases:'
  foreach ($v in $data.target.urlVariants) { Write-Host ('  ' + $v.id + '  ' + $v.kind + '  -> ' + $v.url) }
  Write-Host 'E10 invocation cases:'
  foreach ($v in $data.target.invocationVariants) { Write-Host ('  ' + $v.id + '  ' + $v.method + '  -> ' + $v.url) }
  Write-Host 'E10 app-state cases:'
  foreach ($v in $data.target.stateVariants) { Write-Host ('  ' + $v.id + '  ' + $v.preState) }
  exit 0
}

# resolve the album/?i= variant from the public lookup (no credentials involved)
foreach ($v in $data.target.urlVariants) {
  if ($v.kind -eq 'cn-album-i-form') {
    $lk = Invoke-AmNavItunesLookup -Id $data.target.songId -Storefront 'cn'
    if ($lk.ok -and $lk.collectionId -ne '') {
      $v.url = ('https://music.apple.com/cn/album/someone-like-you/' + $lk.collectionId + '?i=' + $data.target.songId)
      Write-Host ('resolved D6 from lookup: ' + $v.url + '  (collection=' + $lk.collectionName + ')')
    } else {
      $v.url = ''
      Write-Host ('D6 skipped: lookup did not return a collectionId (' + $lk.error + ')')
    }
  }
}

$run = @()
foreach ($v in $data.target.urlVariants) { if ($v.url -ne '') { $run += $v } }
$data.target.urlVariants = $run

$matrix = Invoke-AmNavMatrix -Data $data -Only $Cases -NoPrepare:$NoPrepare -Full:$Full

# the two files the phase explicitly asks for
$dir = Get-AmNavReportDir
$primary = $matrix.rows | Where-Object { $_.id -eq 'E10-D1' }
if ($primary) {
  Write-AmNavJson (Join-Path $dir 'E10-navigation-timeline.json') $primary
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('E10 navigation timeline - ' + $primary.url)
  $lines.Add('invocation: ' + $primary.invocationCommand + '  started=' + $primary.invocationStarted + '  exitCode=' + $primary.invocationExitCode + '  error=[' + $primary.invocationError + ']')
  $lines.Add('pre-state: window=[' + $primary.windowTitleBefore + '] signature=' + $primary.signatureBefore + ' listItems=' + $primary.listItemsBefore + ' smtc=[' + $primary.smtcBefore + ']')
  $lines.Add('verdict: ' + $primary.verdict + '  firstChangeMs=' + $primary.firstChangeMs)
  $lines.Add('')
  $lines.Add('pointMs | actualMs | windowTitle | foreground | listItems | sig | smtcTitle / status | targetVisible | nodeCount')
  foreach ($p in $primary.timeline) {
    $vis = ''
    if ($p.textHits -ne $null) { foreach ($k in $p.textHits.Keys) { if ($p.textHits[$k]) { $vis += ($k + ' ') } } }
    $lines.Add(('' + $p.pointMs + ' | ' + $p.actualMs + ' | ' + $p.windowTitle + ' | ' + $p.isForeground + ' | ' + $p.listItemCount + ' | ' + $p.signature + ' | ' + $p.smtcTitle + ' / ' + $p.smtcStatus + ' | ' + $vis + ' | ' + $p.nodeCount))
  }
  Write-AmNavText (Join-Path $dir 'E10-navigation-timeline.txt') ($lines -join "`r`n")
  Write-Host ''
  Write-Host ('timeline: ' + (Join-Path $dir 'E10-navigation-timeline.txt'))
}

Write-Host ''
Write-Host 'verdicts:'
foreach ($r in $matrix.rows) { Write-Host ('  ' + $r.id.PadRight(10) + ' ' + $r.verdict) }
