# ============================================================
# 04-com-server-surface.ps1   (READ-ONLY reconnaissance)
#
# Purpose: fully dump the windows.comServer / proxyStub declarations of AppleInc.AppleMusicWin,
#          extract every CLSID/AppID/Interface GUID, and check how (and whether) they are
#          registered in the machine registry - i.e. whether a NON-packaged process like
#          MineRadio could legally CoCreateInstance them.
#
# Safety: read-only registry/file inspection. No activation attempts here (that is 05/06).
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\04-com-server-surface.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$outFile = Join-Path $outDir '04-com-server-surface.txt'
$manifest = Join-Path $outDir '02-appxmanifest.xml'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

if (-not (Test-Path $manifest)) { Say ('manifest not found: ' + $manifest); exit 1 }
[xml]$xml = Get-Content -Path $manifest -Raw
$raw = Get-Content -Path $manifest -Raw

function Recursive-Dump($node, [int]$depth) {
  foreach ($child in $node.ChildNodes) {
    if ($child.NodeType -ne 'Element') { continue }
    $pad = ' ' * (6 + $depth * 2)
    $attrs = ''
    foreach ($a in $child.Attributes) { $attrs += (' ' + $a.Name + '=' + $a.Value) }
    Say ($pad + $child.LocalName + $attrs)
    Recursive-Dump $child ($depth + 1)
  }
}

Say '=== A. windows.comServer declaration (full tree) ==='
$com = $xml.SelectNodes('//*[local-name()="Extension" and @Category="windows.comServer"]')
Say ('  count=' + $com.Count)
foreach ($n in $com) { Recursive-Dump $n 0 }

Say ''
Say '=== B. proxyStub declaration (full tree, gives client-side interface set) ==='
$ps = $xml.SelectNodes('//*[local-name()="Extension" and @Category="windows.activatableClass.proxyStub"]')
Say ('  count=' + $ps.Count)
foreach ($n in $ps) { Recursive-Dump $n 0 }

Say ''
Say '=== C. All GUIDs found in manifest (Class / Interface / TypeLib / AppId) ==='
$guids = [regex]::Matches($raw, '\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}') | ForEach-Object { $_.Value.ToUpper() } | Sort-Object -Unique
Say ('  unique GUIDs: ' + $guids.Count)
foreach ($g in $guids) {
  $context = ''
  $i = $raw.ToUpper().IndexOf($g)
  if ($i -ge 0) {
    $start = [Math]::Max(0, $i - 160)
    $len = [Math]::Min(220, $raw.Length - $start)
    $context = ($raw.Substring($start, $len) -replace "`r?`n", ' ')
  }
  Say ('  ' + $g)
  Say ('      ctx: ' + $context)
}

Say ''
Say '=== D. Registry registration for each GUID ==='
foreach ($g in $guids) {
  foreach ($path in @("HKCR:\CLSID\$g", "HKLM:\SOFTWARE\Classes\CLSID\$g", "HKCU:\Software\Classes\CLSID\$g", "HKCR:\AppID\$g", "HKLM:\SOFTWARE\Classes\AppID\$g", "HKCR:\Interface\$g", "HKLM:\SOFTWARE\Classes\Interface\$g")) {
    if (Test-Path $path) {
      Say ('  [FOUND] ' + $path)
      $props = Get-ItemProperty -Path $path -ErrorAction SilentlyContinue
      foreach ($p in $props.PSObject.Properties) {
        if ($p.Name -like 'PS*') { continue }
        Say ('      value ' + $p.Name + ' = ' + $p.Value)
      }
      Get-ChildItem -Path $path -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        $sub = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
        $extra = ''
        foreach ($p in $sub.PSObject.Properties) {
          if ($p.Name -like 'PS*') { continue }
          $extra += (' [' + $p.Name + '=' + $p.Value + ']')
        }
        Say ('      subkey ' + $_.PSChildName + $extra)
      }
    }
  }
  # packaged COM registrations also show up in the AppModel hive
  $appModel = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData' -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -match 'AppleMusic' }
  foreach ($a in $appModel) {
    $hit = Get-ChildItem -Path $a.PSPath -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match [regex]::Escape($g) }
    foreach ($h in $hit) { Say ('  [AppModel] ' + $h.Name) }
  }
}

Say ''
Say '=== E. Packaged COM registration (HKCR\PackagedCom) ==='
$packagedCom = 'HKLM:\SOFTWARE\Classes\PackagedCom'
if (Test-Path $packagedCom) {
  Say '  HKLM\SOFTWARE\Classes\PackagedCom present'
  Get-ChildItem "$packagedCom\Class" -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
    $server = $props.'Server' + ''
    $pkgId = $props.'PackageId' + ''
    if ($pkgId -match 'AppleMusic' -or $_.PSChildName -in $guids) {
      Say ('    Class ' + $_.PSChildName + '  Server=' + $server + '  PackageId=' + $pkgId)
    }
  }
  Get-ChildItem "$packagedCom\Package" -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match 'AppleMusic' } | ForEach-Object {
    Say ('    Package ' + $_.PSChildName)
  }
} else { Say '  HKLM\SOFTWARE\Classes\PackagedCom not present' }

Say ''
Say '=== F. Interface registrations for the two named library interfaces ==='
foreach ($pair in @(@('IAMPLibrary', 'F707A913-E0CE-4FD4-BCE3-425DD153285B'), @('IAMPMusicLibrary', '68E7097C-F969-4006-AAC3-95115F0ED1C4'))) {
  $name = $pair[0]; $guid = $pair[1]
  Say ('  ' + $name + ' ' + $guid)
  foreach ($path in @("HKCR:\Interface\$guid", "HKLM:\SOFTWARE\Classes\Interface\$guid", "HKCR:\TypeLib")) {
    if (Test-Path $path) { Say ('      [FOUND] ' + $path) }
  }
}

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
