# ============================================================
# 05-com-activation-test.ps1   (reconnaissance + minimal activation probe)
#
# Purpose: determine whether the packaged out-of-process COM server of Apple Music
#          (AMPLibraryAgent.exe, class AMP.Core.IAMPMusicLibrary) is reachable from a
#          NON-packaged process such as MineRadio, and whether the declared interfaces
#          (IAMPLibrary / IAMPMusicLibrary) can actually be obtained.
#
# What it does (in order):
#   1. dumps PackagedCom registry mapping (ClassIndex -> Package -> CLSID)
#   2. dumps CLSID/AppID/Interface/TypeLib registrations for the two GUIDs
#   3. CoCreateInstance({68E7097C-...}) via Activator + QueryInterface for both IIDs
#   4. looks for a type library (method names) - dumps names only, never calls anything
#
# Safety: no method is invoked on the COM object; only activation + QueryInterface, which are
#         the minimum needed to answer "is it reachable at all". Read-only elsewhere.
#         Nothing is written outside findings\.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\05-com-activation-test.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$outFile = Join-Path $outDir '05-com-activation-test.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

$CLSID_MUSIC_LIBRARY = '{68E7097C-F969-4006-AAC3-95115F0ED1C4}'
$IID_AMP_LIBRARY = '{F707A913-E0CE-4FD4-BCE3-425DD153285B}'
$IID_AMP_MUSIC_LIBRARY = '{68E7097C-F969-4006-AAC3-95115F0ED1C4}'
$PFN = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa'
$FULL = 'AppleInc.AppleMusicWin_1.1540.23042.0_x64__nzyj5cx40ttqa'

Say '=== A. PackagedCom registry mapping (machine wide COM catalog) ==='
foreach ($p in @("HKLM:\SOFTWARE\Classes\PackagedCom\ClassIndex\$CLSID_MUSIC_LIBRARY", "HKLM:\SOFTWARE\Classes\PackagedCom\Package\$FULL")) {
  if (Test-Path $p) {
    Say ('  [FOUND] ' + $p)
    Get-ChildItem -Path $p -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      $props = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
      $extra = ''
      foreach ($v in $props.PSObject.Properties) {
        if ($v.Name -like 'PS*') { continue }
        $extra += (' [' + $v.Name + '=' + $v.Value + ']')
      }
      Say ('      ' + $_.Name.Replace('HKEY_LOCAL_MACHINE\SOFTWARE\Classes\PackagedCom', '') + $extra)
    }
  } else {
    Say ('  [absent] ' + $p)
  }
}
Say ''
Say '  all PackagedCom packages containing Apple:'
Get-ChildItem 'HKLM:\SOFTWARE\Classes\PackagedCom\Package' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match 'Apple' } | ForEach-Object {
  Say ('    ' + $_.PSChildName)
}
Say ''
Say '  ClassIndex entries pointing at any Apple package:'
Get-ChildItem 'HKLM:\SOFTWARE\Classes\PackagedCom\ClassIndex' -ErrorAction SilentlyContinue | ForEach-Object {
  $sub = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
  $isApple = $false
  foreach ($v in $sub.PSObject.Properties) { if (("" + $v.Value) -match 'Apple') { $isApple = $true } }
  if ($isApple) {
    $extra = ''
    foreach ($v in $sub.PSObject.Properties) { if ($v.Name -notlike 'PS*') { $extra += (' [' + $v.Name + '=' + $v.Value + ']') } }
    Say ('    ' + $_.PSChildName + $extra)
  }
}

Say ''
Say '=== B. CLSID / AppID / Interface / TypeLib registration ==='
foreach ($g in @($CLSID_MUSIC_LIBRARY, $IID_AMP_LIBRARY)) {
  foreach ($p in @("HKCR:\CLSID\$g", "HKLM:\SOFTWARE\Classes\CLSID\$g", "HKCU:\Software\Classes\CLSID\$g")) {
    if (Test-Path $p) {
      Say ('  [FOUND] ' + $p)
      $props = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
      foreach ($v in $props.PSObject.Properties) { if ($v.Name -notlike 'PS*') { Say ('      value ' + $v.Name + ' = ' + $v.Value) } }
      Get-ChildItem -Path $p -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        $sub = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
        $extra = ''
        foreach ($v in $sub.PSObject.Properties) { if ($v.Name -notlike 'PS*') { $extra += (' [' + $v.Name + '=' + $v.Value + ']') } }
        Say ('      subkey ' + $_.PSChildName + $extra)
      }
    } else { Say ('  [absent] ' + $p) }
  }
}
foreach ($g in @($IID_AMP_LIBRARY, $IID_AMP_MUSIC_LIBRARY)) {
  foreach ($p in @("HKCR:\Interface\$g", "HKLM:\SOFTWARE\Classes\Interface\$g", "HKCU:\Software\Classes\Interface\$g")) {
    if (Test-Path $p) {
      Say ('  [FOUND] ' + $p)
      Get-ChildItem -Path $p -Recurse -ErrorAction SilentlyContinue | Select-Object -First 6 | ForEach-Object {
        $sub = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
        $extra = ''
        foreach ($v in $sub.PSObject.Properties) { if ($v.Name -notlike 'PS*') { $extra += (' [' + $v.Name + '=' + $v.Value + ']') } }
        Say ('      subkey ' + $_.PSChildName + $extra)
      }
    }
  }
}

Say ''
Say '=== C. Activation probe: CoCreateInstance from this (non-packaged) process ==='
$type = $null
try {
  $type = [Type]::GetTypeFromCLSID([Guid]$CLSID_MUSIC_LIBRARY)
  Say ('  GetTypeFromCLSID -> ' + $type.FullName)
} catch {
  Say ('  GetTypeFromCLSID failed: ' + $_.Exception.Message)
}
if ($type) {
  try {
    $obj = [Activator]::CreateInstance($type)
    Say ('  CoCreateInstance -> SUCCESS (' + $obj.GetType().FullName + ')')
    # QueryInterface for the declared interfaces (no method calls)
    $ptr = [System.Runtime.InteropServices.Marshal]::GetIUnknownForObject($obj)
    foreach ($iid in @($IID_AMP_LIBRARY, $IID_AMP_MUSIC_LIBRARY, '{00000000-0000-0000-C000-000000000046}')) {
      $out = [IntPtr]::Zero
      $g = [Guid]$iid
      try {
        $hr = [System.Runtime.InteropServices.Marshal]::QueryInterface($ptr, [ref]$g, [ref]$out)
        $obtained = ' (no interface)'
        if ($out -ne [IntPtr]::Zero) { $obtained = ' (interface obtained)' }
        Say ('  QI ' + $iid + ' -> hr=0x' + ('{0:X8}' -f $hr) + $obtained)
        if ($out -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::Release($out) | Out-Null }
      } catch {
        Say ('  QI ' + $iid + ' threw: ' + $_.Exception.Message)
      }
    }
    [System.Runtime.InteropServices.Marshal]::Release($ptr) | Out-Null
  } catch {
    $ex = $_.Exception
    $hrText = ''
    if ($ex.InnerException) { $hrText = $ex.InnerException.Message }
    Say ('  CoCreateInstance -> FAILED: ' + $ex.Message + ' ' + $hrText)
  }
}

Say ''
Say '=== D. Existing AMPLibraryAgent process state (before/after probe) ==='
Get-Process -Name 'AMPLibraryAgent' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | ForEach-Object {
  Say ('  pid=' + $_.Id + '  started=' + $_.StartTime)
}
$procs = Get-Process -Name 'AMPLibraryAgent' -ErrorAction SilentlyContinue
if (-not $procs) { Say '  (AMPLibraryAgent not running)' }

Say ''
Say '=== E. Type library / method names (names only, no calls) ==='
$candidates = @()
if (Test-Path 'HKCR:\TypeLib') {
  Get-ChildItem 'HKCR:\TypeLib' -ErrorAction SilentlyContinue | ForEach-Object {
    $g = $_.PSChildName
    $sub = Get-ChildItem -Path $_.PSPath -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match 'win64|x64' }
    foreach ($s in $sub) {
      $props = Get-ItemProperty -Path $s.PSPath -ErrorAction SilentlyContinue
      $path = $props.'(default)'
      if ($path -match 'Apple') { $candidates += ($g + ' -> ' + $path) }
    }
  }
}
if ($candidates) { foreach ($c in $candidates) { Say ('  ' + $c) } } else { Say '  no Apple type library registered under HKCR\TypeLib' }

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
