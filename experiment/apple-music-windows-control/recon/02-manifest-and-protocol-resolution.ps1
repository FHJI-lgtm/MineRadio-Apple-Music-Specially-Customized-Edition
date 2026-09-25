# ============================================================
# 02-manifest-and-protocol-resolution.ps1   (READ-ONLY reconnaissance)
#
# Purpose: read the raw AppxManifest.xml of AppleInc.AppleMusicWin and extract its official
#          activation surface (protocol schemes, appService, appExtension, capabilities),
#          then resolve the EFFECTIVE shell command for each scheme with the official
#          AssocQueryStringW API (same API Explorer / ShellExecute uses).
#
# Safety: read-only. No registry writes. No network. No credentials.
# ASCII-only on purpose (Windows PowerShell 5.1 + no BOM).
# Usage: powershell -ExecutionPolicy Bypass -File recon\02-manifest-and-protocol-resolution.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir '02-manifest-and-protocol-resolution.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

$pkg = Get-AppxPackage -Name 'AppleInc.AppleMusicWin'
if (-not $pkg) { Say 'AppleInc.AppleMusicWin not installed'; exit 1 }
$loc = $pkg.InstallLocation
Say '=== A. Raw AppxManifest.xml ==='
$manifestPath = Join-Path $loc 'AppxManifest.xml'
Say ("  path: " + $manifestPath)
if (Test-Path $manifestPath) {
  $raw = Get-Content -Path $manifestPath -Raw -ErrorAction SilentlyContinue
  if (-not $raw) { $raw = Get-Content -Path $manifestPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue }
  Say ("  read OK, length = " + ([string]$raw).Length)
  $exportPath = Join-Path $outDir '02-appxmanifest.xml'
  Set-Content -Path $exportPath -Value $raw -Encoding UTF8
  Say ("  exported: findings\02-appxmanifest.xml")
  $xml = [string]$raw
  Say ''
  Say '  -- Identity --'
  $idTag = [regex]::Match($xml, '<Identity\b[^>]*>').Value
  Say ("    " + $idTag)
  Say '  -- Applications --'
  foreach ($m in [regex]::Matches($xml, '<Application\b[^>]*>')) {
    $tag = $m.Value
    $aid = [regex]::Match($tag, 'Id="([^"]*)"').Groups[1].Value
    $exe = [regex]::Match($tag, 'Executable="([^"]*)"').Groups[1].Value
    $entry = [regex]::Match($tag, 'EntryPoint="([^"]*)"').Groups[1].Value
    $vis = [regex]::Match($tag, 'AppListEntry="([^"]*)"').Groups[1].Value
    Say ("    Id=" + $aid + "  Executable=" + $exe + "  EntryPoint=" + $entry + "  AppListEntry=" + $vis)
  }
  Say '  -- Extension categories (with key attributes) --'
  foreach ($m in [regex]::Matches($xml, '<(?:uap:)?Extension\b[^>]*>')) {
    $tag = $m.Value
    $cat = [regex]::Match($tag, 'Category="([^"]*)"').Groups[1].Value
    $name = [regex]::Match($tag, 'Name="([^"]*)"').Groups[1].Value
    $exec = [regex]::Match($tag, 'Executable="([^"]*)"').Groups[1].Value
    $entry = [regex]::Match($tag, 'EntryPoint="([^"]*)"').Groups[1].Value
    if ($cat) { Say ("    Category=" + $cat + "  Name=" + $name + "  Executable=" + $exec + "  EntryPoint=" + $entry) }
  }
  Say '  -- Protocol schemes --'
  $schemes = [regex]::Matches($xml, '<(?:uap:)?Protocol\b[^>]*Name="([^"]*)"') | ForEach-Object { $_.Groups[1].Value }
  if ($schemes) { foreach ($s in ($schemes | Sort-Object -Unique)) { Say ("    " + $s) } } else { Say '    (none)' }
  Say '  -- AppService --'
  $svc = [regex]::Matches($xml, '<(?:uap:)?AppService\b[^>]*Name="([^"]*)"') | ForEach-Object { $_.Groups[1].Value }
  if ($svc) { foreach ($s in ($svc | Sort-Object -Unique)) { Say ("    " + $s) } } else { Say '    (none)' }
  Say '  -- AppExtension --'
  $ext = [regex]::Matches($xml, '<uap:AppExtension\b[^>]*Name="([^"]*)"') | ForEach-Object { $_.Groups[1].Value }
  if ($ext) { foreach ($e in ($ext | Sort-Object -Unique)) { Say ("    " + $e) } } else { Say '    (none)' }
  Say '  -- Capabilities --'
  foreach ($c in ([regex]::Matches($xml, '<(?:rescap:)?Capability\b[^>]*Name="([^"]*)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)) {
    Say ("    " + $c)
  }
  Say '  -- AppExecutionAlias / uap5 aliases --'
  $aliases = [regex]::Matches($xml, 'Alias="([^"]*)"') | ForEach-Object { $_.Groups[1].Value }
  if ($aliases) { foreach ($a in ($aliases | Sort-Object -Unique)) { Say ("    " + $a) } } else { Say '    (none)' }
  Say '  -- extension names mentioning play/open/song/track --'
  foreach ($k in @('play', 'song', 'track', 'open', 'search', 'sharing', 'appservice')) {
    $hits = [regex]::Matches($xml, '="[^"]*' + $k + '[^"]*"', 'IgnoreCase') | ForEach-Object { $_.Value } | Sort-Object -Unique
    if ($hits) { Say ("    [" + $k + "] " + (($hits | Select-Object -First 8) -join ' , ')) }
  }
} else {
  Say '  AppxManifest.xml NOT readable'
}
Say ''

Say '=== B. Full registry tree of each registered scheme ==='
foreach ($s in @('musics', 'music', 'itms', 'itmss')) {
  foreach ($hive in @('HKCU:\Software\Classes', 'HKLM:\SOFTWARE\Classes')) {
    $key = Join-Path $hive $s
    if (-not (Test-Path $key)) { continue }
    Say ("  --- " + $hive + "\" + $s + " ---")
    $root = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    foreach ($n in $root.PSObject.Properties) {
      if ($n.Name -like 'PS*') { continue }
      Say ("    value " + $n.Name + " = " + $n.Value)
    }
    Get-ChildItem -Path $key -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
      $default = $p.'(default)'
      $extra = ''
      foreach ($n in $p.PSObject.Properties) {
        if ($n.Name -like 'PS*' -or $n.Name -eq '(default)') { continue }
        $extra += (' [' + $n.Name + '=' + $n.Value + ']')
      }
      Say ("    subkey " + $_.PSChildName + "  (default)=" + $default + $extra)
    }
  }
}
Say ''

Say '=== C. Effective command via AssocQueryStringW (official shell API) ==='
$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Assoc {
  [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode)]
  private static extern uint AssocQueryString(int flags, int str, string pszAssoc, string pszExtra, StringBuilder pszOut, ref uint pcchOut);
  public static string Command(string scheme) {
    uint size = 2048;
    StringBuilder sb = new StringBuilder((int)size);
    uint hr = AssocQueryString(0, 2 /* ASSOCSTR_COMMAND */, scheme, null, sb, ref size);
    if (hr != 0) {
      size = 2048;
      sb = new StringBuilder((int)size);
      hr = AssocQueryString(0, 1 /* ASSOCSTR_EXECUTABLE */, scheme, null, sb, ref size);
      if (hr != 0) return "(AssocQueryString failed hr=0x" + hr.ToString("X8") + ")";
      return "EXECUTABLE: " + sb.ToString();
    }
    return sb.ToString();
  }
  public static string Friendly(string scheme) {
    uint size = 1024;
    StringBuilder sb = new StringBuilder((int)size);
    uint hr = AssocQueryString(0, 4 /* ASSOCSTR_FRIENDLYAPPNAME */, scheme, null, sb, ref size);
    return hr == 0 ? sb.ToString() : "(n/a)";
  }
}
'@
try {
  Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop
  foreach ($s in @('musics', 'music', 'itms', 'itmss', 'https')) {
    Say ("  " + $s + "  ->  " + [Assoc]::Command($s))
    Say ("      app: " + [Assoc]::Friendly($s))
  }
} catch {
  Say ('  Add-Type failed: ' + $_.Exception.Message)
}
Say ''

Say '=== D. Per-user AppExecutionAlias entries (WindowsApps alias) ==='
$aliasRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
Get-ChildItem -Path $aliasRoot -Filter '*Apple*' -ErrorAction SilentlyContinue | ForEach-Object {
  Say ("  " + $_.Name + "  " + $_.FullName)
}
$aliasRoot2 = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
Get-ChildItem -Path $aliasRoot2 -Filter '*Music*' -ErrorAction SilentlyContinue | ForEach-Object {
  Say ("  " + $_.Name + "  " + $_.FullName)
}

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
