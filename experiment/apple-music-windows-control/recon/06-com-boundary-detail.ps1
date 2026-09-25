# ============================================================
# 06-com-boundary-detail.ps1   (reconnaissance)
#
# Purpose: close out the COM question:
#   - is the packaged COM object usable through IDispatch (late binding / method enumeration)?
#   - what exactly does the manifest declare for comServer / proxyStub (raw snippets)?
#
# Safety: activation + QueryInterface only; no method is invoked. Read-only elsewhere.
# ASCII-only on purpose.
# Usage: powershell -ExecutionPolicy Bypass -File recon\06-com-boundary-detail.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '..\findings'
$outFile = Join-Path $outDir '06-com-boundary-detail.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { $lines.Add($text); Write-Host $text }

$CLSID = '{68E7097C-F969-4006-AAC3-95115F0ED1C4}'
$IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}'
$IID_IAGILE = '{94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}'
$IID_IMARSHAL = '{00000003-0000-0000-C000-000000000046}'

Say '=== A. CoCreateInstance + interface probing (no calls) ==='
try {
  $obj = [Activator]::CreateInstance([Type]::GetTypeFromCLSID([Guid]$CLSID))
  Say '  CoCreateInstance -> SUCCESS'
  $ptr = [System.Runtime.InteropServices.Marshal]::GetIUnknownForObject($obj)
  foreach ($iid in @($IID_IDISPATCH, $IID_IAGILE, $IID_IMARSHAL)) {
    $out = [IntPtr]::Zero
    $g = [Guid]$iid
    $hr = [System.Runtime.InteropServices.Marshal]::QueryInterface($ptr, [ref]$g, [ref]$out)
    $note = ' (no interface)'
    if ($out -ne [IntPtr]::Zero) { $note = ' (obtained)' }
    Say ('  QI ' + $iid + ' -> hr=0x' + ('{0:X8}' -f $hr) + $note)
    if ($out -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::Release($out) | Out-Null }
  }
  [System.Runtime.InteropServices.Marshal]::Release($ptr) | Out-Null
  Say ''
  Say '  attempt to use it as IDispatch (late binding):'
  try {
    $d = [System.Runtime.InteropServices.Marshal]::GetIDispatchForObject($obj)
    Say ('    GetIDispatchForObject -> ok, ptr=' + $d)
    if ($d -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::Release($d) | Out-Null }
  } catch {
    Say ('    GetIDispatchForObject -> failed: ' + $_.Exception.Message)
  }
} catch {
  Say ('  CoCreateInstance -> FAILED: ' + $_.Exception.Message)
}

Say ''
Say '=== B. Raw manifest snippets: comServer / proxyStub ==='
$manifest = Join-Path $outDir '02-appxmanifest.xml'
if (Test-Path $manifest) {
  $raw = Get-Content -Path $manifest -Raw
  foreach ($needle in @('ComServer', 'ProxyStub')) {
    $i = $raw.IndexOf($needle)
    Say ('  --- ' + $needle + ' (offset ' + $i + ') ---')
    if ($i -ge 0) {
      $start = [Math]::Max(0, $i - 700)
      $len = [Math]::Min(1500, $raw.Length - $start)
      Say ('  ' + ($raw.Substring($start, $len) -replace "`r?`n", ' '))
    }
  }
  Say ''
  Say '  --- full <Extensions> length stats ---'
  Say ('  manifest length: ' + $raw.Length)
  Say ('  occurrences of Application Id=: ' + ([regex]::Matches($raw, '<Application\b').Count))
}

Say ''
Say '=== C. AMPLibraryAgent process / command line (observed) ==='
$procs = Get-CimInstance Win32_Process -Filter "Name = 'AMPLibraryAgent.exe'" -ErrorAction SilentlyContinue
if ($procs) {
  foreach ($p in $procs) {
    Say ('  pid=' + $p.ProcessId)
    Say ('  cmd=' + $p.CommandLine)
    Say ('  exe=' + $p.ExecutablePath)
  }
} else { Say '  not running' }

$music = Get-CimInstance Win32_Process -Filter "Name = 'AppleMusic.exe'" -ErrorAction SilentlyContinue
Say ''
Say '=== D. AppleMusic.exe process / command line (observed) ==='
if ($music) {
  foreach ($p in $music) {
    Say ('  pid=' + $p.ProcessId)
    Say ('  cmd=' + $p.CommandLine)
    Say ('  exe=' + $p.ExecutablePath)
  }
} else { Say '  AppleMusic.exe not running' }

Set-Content -Path $outFile -Value ($lines -join "`r`n") -Encoding UTF8
Write-Host ''
Write-Host ('report written: ' + $outFile)
