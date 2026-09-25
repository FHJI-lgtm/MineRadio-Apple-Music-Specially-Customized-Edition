# ============================================================
# 01-install-and-protocols.ps1   (READ-ONLY reconnaissance)
#
# Purpose: identify how Apple Music for Windows is packaged/installed, and enumerate its
#          OFFICIAL activation surface (URL Protocol handlers, AppService, AppExtension).
#
# Safety: strictly read-only (Get-AppxPackage / Get-AppxPackageManifest / Test-Path / Get-ItemProperty).
#         No registry writes, no writes outside this experiment folder, no credentials touched.
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 parses .ps1 as ANSI when there
#       is no BOM, so non-ASCII text can corrupt the parser. Chinese notes live in the generated
#       findings file and in findings/REPORT.md instead.
#
# Usage: powershell -ExecutionPolicy Bypass -File recon\01-install-and-protocols.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir '01-install-and-protocols.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

Say '=== A. Operating system ==='
$os = Get-CimInstance Win32_OperatingSystem
Say ("  Caption      : " + $os.Caption)
Say ("  Version/Build: " + $os.Version + " / " + $os.BuildNumber)
Say ("  Architecture : " + $os.OSArchitecture)
Say ''

Say '=== B. Apple Music install / packaging type ==='
$pkg = Get-AppxPackage -Name 'AppleInc.AppleMusicWin'
if (-not $pkg) {
  Say '  AppleInc.AppleMusicWin (MSIX) NOT found'
} else {
  Say ("  Name           : " + $pkg.Name)
  Say ("  PackageFamily  : " + $pkg.PackageFamilyName)
  Say ("  Version        : " + $pkg.Version)
  Say ("  InstallLocation: " + $pkg.InstallLocation)
  Say ("  SignatureKind  : " + $pkg.SignatureKind + "   (Store = Microsoft Store signed)")
  Say ("  IsFramework    : " + $pkg.IsFramework)
  Say ("  PublisherId    : " + $pkg.PublisherId)
  $exeGuess = Get-ChildItem -Path $pkg.InstallLocation -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 12
  if ($exeGuess) {
    Say '  executables inside install folder:'
    foreach ($e in $exeGuess) { Say ("    " + $e.Name + "   " + [math]::Round($e.Length / 1MB, 2) + " MB") }
  } else {
    Say '  (install folder not listable - WindowsApps ACL; normal for MSIX)'
  }
  Say '  other packages from the same publisher:'
  Get-AppxPackage | Where-Object { $_.PublisherId -eq $pkg.PublisherId } | ForEach-Object {
    Say ("    " + $_.Name + "  " + $_.Version)
  }
}
Say ''

Say '=== C. AppxManifest: applications + extension declarations ==='
if ($pkg) {
  try {
    $manifest = Get-AppxPackageManifest -Package $pkg.PackageFamilyName
    $xml = $manifest.OuterXml
    if (-not $xml) { $xml = ($manifest | Out-String) }
    $xmlPath = Join-Path $outDir '01-appxmanifest.xml'
    Set-Content -Path $xmlPath -Value $xml -Encoding UTF8
    Say ("  manifest exported to: findings\01-appxmanifest.xml  (" + $xml.Length + " chars)")
    $appMatches = [regex]::Matches($xml, '<Application\b[^>]*>')
    foreach ($m in $appMatches) {
      $id = [regex]::Match($m.Value, 'Id="([^"]*)"').Groups[1].Value
      $exe = [regex]::Match($m.Value, 'Executable="([^"]*)"').Groups[1].Value
      $entry = [regex]::Match($m.Value, 'EntryPoint="([^"]*)"').Groups[1].Value
      $appList = [regex]::Match($m.Value, 'AppListEntry="([^"]*)"').Groups[1].Value
      Say ("  Application   Id=" + $id + "  Executable=" + $exe + "  EntryPoint=" + $entry + "  AppListEntry=" + $appList)
    }
    $cats = [regex]::Matches($xml, 'Category="([^"]*)"') | ForEach-Object { $_.Groups[1].Value } | Group-Object | Sort-Object Name
    Say '  extension categories declared:'
    foreach ($c in $cats) { Say ("    " + $c.Name + " x" + $c.Count) }
    $protoNames = [regex]::Matches($xml, '<(?:uap:)?Protocol\b[^>]*Name="([^"]*)"') | ForEach-Object { $_.Groups[1].Value }
    Say '  windows.protocol schemes declared:'
    if ($protoNames) { foreach ($p in ($protoNames | Sort-Object -Unique)) { Say ("    " + $p) } } else { Say '    (none)' }
    $svcMatches = [regex]::Matches($xml, '<(?:uap:)?AppService\b[^>]*Name="([^"]*)"')
    Say '  windows.appService declared:'
    if ($svcMatches.Count -gt 0) { foreach ($m in $svcMatches) { Say ("    " + $m.Groups[1].Value) } } else { Say '    (none)' }
    $caps = [regex]::Matches($xml, '<(?:rescap:)?Capability\b[^>]*Name="([^"]*)"') | ForEach-Object { $_.Groups[1].Value }
    Say '  capabilities declared:'
    foreach ($c in ($caps | Sort-Object -Unique)) { Say ("    " + $c) }
  } catch {
    Say ('  manifest read failed: ' + $_.Exception.Message)
  }
}
Say ''

Say '=== D. Protocol handlers in registry (HKCU / HKLM) ==='
$schemes = @('musics', 'music', 'itms', 'itmss', 'itms-apps', 'itms-appss', 'apple-music', 'applemusic', 'pcast', 'podcasts')
foreach ($s in $schemes) {
  $found = $false
  foreach ($hive in @('HKCU:\Software\Classes', 'HKLM:\SOFTWARE\Classes')) {
    $key = Join-Path $hive $s
    if (Test-Path $key) {
      $found = $true
      Say ("  [" + $hive + "\" + $s + "]")
      $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
      Say ("    (default)=" + $props.'(default)' + "   URL Protocol=" + $props.'URL Protocol')
      foreach ($sub in @('shell\open\command', 'Application', 'DefaultIcon')) {
        $subKey = Join-Path $key $sub
        if (Test-Path $subKey) {
          $v = Get-ItemProperty -Path $subKey -ErrorAction SilentlyContinue
          Say ("    " + $sub + " = " + $v.'(default)')
        }
      }
      $dde = Join-Path $key 'shell\open\ddeexec'
      if (Test-Path $dde) { Say ("    shell\open\ddeexec = " + (Get-ItemProperty -Path $dde -ErrorAction SilentlyContinue).'(default)') }
    }
  }
  if (-not $found) { Say ("  [" + $s + "] not registered") }
}
Say ''

Say '=== E. Modern MSIX extension registration (ContractId) ==='
if ($pkg) {
  $pfn = $pkg.PackageFamilyName
  foreach ($cid in @('Windows.Protocol', 'Windows.AppService', 'Windows.AppExtension', 'Windows.FileTypeAssociation', 'Windows.ShareTarget', 'Windows.StartupTask')) {
    foreach ($p in @("HKLM:\SOFTWARE\Classes\Extensions\ContractId\$cid\PackageId\$pfn",
                     "HKCU:\Software\Classes\Extensions\ContractId\$cid\PackageId\$pfn")) {
      if (Test-Path $p) {
        Say ("  [" + $cid + "] " + $p)
        Get-ChildItem -Path $p -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
          $name = $props.'Name'
          $cls = $props.'ActivatableClassId'
          if ($name -or $cls) { Say ("      " + $_.PSChildName + "   Name=" + $name + "  ActivatableClassId=" + $cls) }
        }
      }
    }
  }
}
Say ''

Say '=== F. Other related registrations ==='
foreach ($p in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\AppleMusic.exe',
                 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\iTunes.exe',
                 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\AppleMusic.exe')) {
  if (Test-Path $p) {
    Say ("  [" + $p + "]")
    Say ("    (default)=" + (Get-ItemProperty -Path $p -ErrorAction SilentlyContinue).'(default)')
  } else { Say ("  [" + $p + "] not present") }
}
Say ''
Say '=== G. ActivatableClasses (per-package activation entries) ==='
$activatable = 'HKCU:\Software\Classes\ActivatableClasses\Package'
if (Test-Path $activatable) {
  $hits = Get-ChildItem $activatable -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match 'AppleMusic' }
  if ($hits) { foreach ($h in $hits) { Say ("  " + $h.PSChildName) } } else { Say '  no AppleMusic activation entries' }
} else { Say '  ActivatableClasses\Package not present' }

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
