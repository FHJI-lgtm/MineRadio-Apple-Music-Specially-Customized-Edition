# ============================================================
# phase3.7B-uia-no-mouse/run-pattern-probe.ps1
# Stage 1: pattern inventory.  It does NOT activate anything - it only navigates
# the page (setup) and then records what the target elements expose.
#   reports/E10-pattern-inventory.json
# ASCII-only.
# ============================================================
[CmdletBinding()]
param([string]$Target = 'E10', [switch]$NoNavigate)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'lib\activation.ps1')

$cfg = Get-Content -Path (Join-Path $PSScriptRoot 'cases\E10.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$t = $cfg.target
$dir = Get-AmNmReportDir

function Strip-AmNmElement($obj) {
  $h = [ordered]@{}
  foreach ($k in $obj.Keys) { if ($k -ne 'element') { $h[$k] = $obj[$k] } }
  return $h
}

$hygiene = Test-AmNmScriptHygiene
Write-Host ('MouseGuard (static): ok=' + $hygiene.ok + ' scanned=' + $hygiene.scanned + ' hits=[' + ($hygiene.hits -join '; ') + ']')

$w = Get-AmNavWindowInfo
Write-Host ('window: found=' + $w.uiaWindowFound + ' iconic=' + $w.iconic + ' foreground=' + $w.isForeground + ' title=[' + $w.title + ']')
if (-not $w.uiaWindowFound) { Write-Host 'Apple Music window not found - abort'; exit 2 }

if (-not $NoNavigate) {
  Write-Host ('setup: navigating to ' + $t.url)
  $nav = Invoke-AmNavDeepLink -Url $t.url -Method 'url'
  Start-Sleep -Seconds 3
}
$rootEl = Get-AmNavWindowElement
$found = Find-AmNmTargetElements $rootEl $t.title $t.artist
Write-Host ('page: nodes=' + $found.nodes + ' listItems=' + $found.listItemTotal + ' titleMatches(listItem)=' + $found.listItemMatches.Count + ' titleMatches(other)=' + $found.textMatches.Count + ' artistNodeSeen=' + $found.artistNodeSeen)

$report = [ordered]@{
  at = (Get-Date).ToString('s'); target = $t; mouseGuardStatic = $hygiene
  window = $w; page = @{ nodes = $found.nodes; listItemTotal = $found.listItemTotal; artistNodeSeen = $found.artistNodeSeen }
  listItemMatches = @(); textMatches = @(); buttonCandidates = @(); parentOfFirstMatch = $null
  interpretation = ''
}

foreach ($m in $found.listItemMatches) {
  $row = Strip-AmNmElement $m
  $row['patterns'] = Get-AmNmPatternInventory $m.element
  $row['legacyAccessible'] = $row['patterns'].details['LegacyIAccessiblePattern']
  $report.listItemMatches += $row
}
foreach ($m in $found.textMatches) {
  $row = Strip-AmNmElement $m
  $row['patterns'] = Get-AmNmPatternInventory $m.element
  $report.textMatches += $row
}
foreach ($m in $found.buttonCandidates) {
  $row = Strip-AmNmElement $m
  $row['patterns'] = Get-AmNmPatternInventory $m.element
  $report.buttonCandidates += $row
}
if ($found.listItemMatches.Count -gt 0) {
  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $parent = $walker.GetParent($found.listItemMatches[0].element)
    if ($parent -ne $null) {
      $p = Get-AmNmElementInfo $parent
      $p['patterns'] = Get-AmNmPatternInventory $parent
      $report.parentOfFirstMatch = $p
    }
  } catch { $report.parentOfFirstMatch = @{ error = $_.Exception.Message } }
}

if ($found.listItemMatches.Count -eq 0) {
  $report.interpretation = 'no list item carries the target title: the row either is not a ListItem or is not materialized'
} else {
  $first = $report.listItemMatches[0]
  if ($first.isOffscreen -or $first.boundsWidth -le 0) {
    $report.interpretation = 'target ListItem exists in the tree but has no usable geometry (offscreen or zero-size) - realization is the question'
  } else {
    $report.interpretation = 'target ListItem exists WITH geometry; activation should be testable directly'
  }
}

Write-AmNavJson (Join-Path $dir 'E10-pattern-inventory.json') $report
Write-Host ''
Write-Host ('interpretation: ' + $report.interpretation)
Write-Host ('patterns on first ListItem match: ' + (($report.listItemMatches[0].patterns.available) -join ','))
if ($found.listItemMatches.Count -gt 0) { Write-Host ('first match: bounds=[' + $report.listItemMatches[0].bounds + '] offscreen=' + $report.listItemMatches[0].isOffscreen + ' enabled=' + $report.listItemMatches[0].isEnabled + ' class=' + $report.listItemMatches[0].className + ' framework=' + $report.listItemMatches[0].frameworkId) }
Write-Host ('report: ' + (Join-Path $dir 'E10-pattern-inventory.json'))
