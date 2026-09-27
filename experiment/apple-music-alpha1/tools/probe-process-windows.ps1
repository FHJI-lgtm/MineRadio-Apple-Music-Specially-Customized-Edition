# Read-only facts for ONE process's visible top-level windows (e.g. MineRadio's own window).
param([Parameter(Mandatory=$true)][int]$Pid2)
$ErrorActionPreference = 'Continue'
$repo = 'F:\mineradio-apple-music'
. (Join-Path $repo 'experiment\apple-music-alpha1\lib\alpha-common.ps1')
$p = Get-Process -Id $Pid2 -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'process not found'; exit 1 }
Write-Output ('pid=' + $p.Id + ' name=' + $p.ProcessName + ' title=' + $p.MainWindowTitle)
# the delegate runs outside the pipeline scope, so collect through a container (method calls only)
$script:ProbeRows = New-Object System.Collections.ArrayList
$cb = [Alpha1Native+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$l)
  $wpid = 0
  [void][Alpha1Native]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ($wpid -eq $Pid2) {
    $ex = [Alpha1Native]::ExStyle($h)
    [void]$script:ProbeRows.Add('hwnd=' + $h + ' class=' + [Alpha1Native]::ClassName($h) + ' title=' + [Alpha1Native]::Title($h) + ' style=0x' + ('{0:X8}' -f [Alpha1Native]::Style($h)) + ' exStyle=0x' + ('{0:X8}' -f $ex) + ' layered=' + (($ex -band [Alpha1Native]::WS_EX_LAYERED) -ne 0) + ' transparent=' + (($ex -band [Alpha1Native]::WS_EX_TRANSPARENT) -ne 0) + ' alpha=' + [Alpha1Native]::ReadAlpha($h) + ' visible=' + [Alpha1Native]::IsWindowVisible($h) + ' iconic=' + [Alpha1Native]::IsIconic($h) + ' rect=' + [Alpha1Native]::RectText($h))
  }
  return $true
}
[void][Alpha1Native]::EnumWindows($cb, [IntPtr]::Zero)
foreach ($row in @($script:ProbeRows.ToArray())) { Write-Output $row }
Write-Output ('foregroundIsThisProcess=' + ([Alpha1Native]::GetForegroundWindow() -eq $p.MainWindowHandle))