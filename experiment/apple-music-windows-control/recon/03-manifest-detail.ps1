# ============================================================
# 03-manifest-detail.ps1   (READ-ONLY reconnaissance)
#
# Purpose: structured dump of AppxManifest Applications/Extensions (category, child element,
#          attributes) so we can see exactly what activation surface Apple Music declares -
#          in particular the "/play \"%1\"" and "/open \"%1\"" strings found earlier, and whether
#          any activatable class / appService is declared as externally activatable.
#
# Safety: read-only, works on the manifest copy already exported under findings\.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\03-manifest-detail.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$outFile = Join-Path $outDir '03-manifest-detail.txt'
$manifest = Join-Path $outDir '02-appxmanifest.xml'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

if (-not (Test-Path $manifest)) { Say ('manifest not found: ' + $manifest); exit 1 }
$raw = Get-Content -Path $manifest -Raw
[xml]$xml = $raw
Say ('=== manifest root: ' + $xml.DocumentElement.Name + ' ===')
$pkgNode = $xml.Package
Say ('  Identity: ' + $pkgNode.Identity.Name + '  Version=' + $pkgNode.Identity.Version + '  Publisher=' + $pkgNode.Identity.Publisher)

function Dump-Attrs($node, [string]$prefix) {
  $s = $prefix
  foreach ($a in $node.Attributes) { $s += (' ' + $a.Name + '=' + $a.Value) }
  return $s
}

Say ''
Say '=== Applications / Extensions (full traversal) ==='
foreach ($app in $pkgNode.Applications.Application) {
  Say ('  Application Id=' + $app.Id + '  Executable=' + $app.Executable + '  EntryPoint=' + $app.EntryPoint)
  $exts = $app.Extensions
  if (-not $exts) { continue }
  foreach ($ext in $exts.ChildNodes) {
    if ($ext.NodeType -ne 'Element') { continue }
    Say ('    Extension ' + (Dump-Attrs $ext '  '))
    foreach ($child in $ext.ChildNodes) {
      if ($child.NodeType -ne 'Element') { continue }
      Say ('      - ' + $child.LocalName + ' ' + (Dump-Attrs $child ''))
      foreach ($grand in $child.ChildNodes) {
        if ($grand.NodeType -ne 'Element') { continue }
        Say ('          . ' + $grand.LocalName + ' ' + (Dump-Attrs $grand ''))
      }
    }
  }
}

Say ''
Say '=== All protocol names (any depth, any namespace) ==='
$protoNodes = $xml.SelectNodes('//*[local-name()="Protocol"]')
foreach ($p in $protoNodes) {
  Say ('  Protocol ' + (Dump-Attrs $p ''))
}
if ($protoNodes.Count -eq 0) { Say '  (no Protocol element)' }

Say ''
Say '=== All AppService declarations (any depth) ==='
$svcNodes = $xml.SelectNodes('//*[local-name()="AppService"]')
foreach ($s in $svcNodes) { Say ('  AppService ' + (Dump-Attrs $s '')) }
if ($svcNodes.Count -eq 0) { Say '  (none)' }

Say ''
Say '=== Activatable class servers (inProcessServer / outOfProcessServer / proxyStub) ==='
foreach ($cat in @('windows.activatableClass.inProcessServer', 'windows.activatableClass.outOfProcessServer', 'windows.activatableClass.proxyStub')) {
  $nodes = $xml.SelectNodes('//*[local-name()="Extension" and @Category="' + $cat + '"]')
  Say ('  [' + $cat + '] count=' + $nodes.Count)
  foreach ($n in $nodes) {
    foreach ($child in $n.ChildNodes) {
      if ($child.NodeType -ne 'Element') { continue }
      $path = $child.GetAttribute('Path')
      Say ('      ' + $child.LocalName + ' Path=' + $path)
      $nullable = $child.GetAttribute('ExternallyActivatable')
      if ($nullable) { Say ('          ExternallyActivatable=' + $nullable) }
      foreach ($cls in $child.ChildNodes) {
        if ($cls.NodeType -ne 'Element') { continue }
        Say ('          . ' + $cls.LocalName + ' ' + (Dump-Attrs $cls ''))
      }
    }
  }
}

Say ''
Say '=== context lines around /play and /open arguments ==='
$idx = 0
while ($true) {
  $i = $raw.IndexOf('/play', $idx)
  if ($i -lt 0) { break }
  $start = [Math]::Max(0, $i - 420)
  $len = [Math]::Min(560, $raw.Length - $start)
  Say '  --- occurrence at offset ' + $i + ' ---'
  Say ('  ' + ($raw.Substring($start, $len) -replace "`r?`n", ' '))
  $idx = $i + 5
}
$idx = 0
while ($true) {
  $i = $raw.IndexOf('/open', $idx)
  if ($i -lt 0) { break }
  $start = [Math]::Max(0, $i - 420)
  $len = [Math]::Min(560, $raw.Length - $start)
  Say '  --- occurrence at offset ' + $i + ' ---'
  Say ('  ' + ($raw.Substring($start, $len) -replace "`r?`n", ' '))
  $idx = $i + 5
}

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
