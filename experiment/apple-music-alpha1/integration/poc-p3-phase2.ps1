# P-3 phase 2: after starting from the 3rd track of the user playlist, does the NEXT track follow that playlist?
param([string]$IdentityFile, [string]$OutFile, [string]$PlaylistNameFile)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function RT([string]$p) { return ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)).Trim() }
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
. (Join-Path $lib 'am-uia.ps1')
if (-not ('AmPocNext' -as [type])) { Add-Type -Namespace Poc -Name AmPocNext -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);' -ErrorAction SilentlyContinue }
$id = Get-Content $IdentityFile -Raw -Encoding UTF8 | ConvertFrom-Json
$tracks = @($id.tracks)
$target = $tracks[2]
$expected = $tracks[3]
$plName = RT $PlaylistNameFile
$o = [ordered]@{ playlist = $plName; targetIndex = 3; targetTitle = [string]$target.name; expectedNextIndex = 4; expectedNextTitle = [string]$expected.name; expectedNextArtist = [string]$expected.artist; steps = [ordered]@{}; verdict = '' }
$sw = [Diagnostics.Stopwatch]::StartNew()
$app = Ensure-AmRunning
$s0 = Get-AmSmtcState
$o.steps.before = @{ status = [string]$s0.status; title = [string]$s0.title; artist = [string]$s0.artist; isTarget = ((Normalize-AmText ([string]$s0.title)) -eq (Normalize-AmText ([string]$target.name))) }
if (-not $o.steps.before.isTarget) { $o.verdict = 'INCONCLUSIVE_NOT_STARTED_FROM_TARGET' } else {
  $root = (Get-AmRoot $app.hwnd).root
  $all = @(); try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } catch { }
  $m = 0; foreach ($n in $all) { try { if ((Normalize-AmText ([string]$n.Current.Name)) -eq (Normalize-AmText $plName)) { $m++ } } catch { } }
  $o.steps.contextBefore = @{ playlistNameMatches = $m }
  [Poc.AmPocNext]::keybd_event(0xB0, 0, 0, [System.UIntPtr]::Zero); [Poc.AmPocNext]::keybd_event(0xB0, 0, 2, [System.UIntPtr]::Zero)
  Start-Sleep -Seconds 7
  $s1 = Get-AmSmtcState
  $o.steps.afterNext = @{ status = [string]$s1.status; title = [string]$s1.title; artist = [string]$s1.artist; ts = (Get-Date).ToString('s') }
  $o.steps.match = @{ titleMatch = ((Normalize-AmText ([string]$s1.title)) -eq (Normalize-AmText ([string]$expected.name))); artistMatch = ((Normalize-AmText ([string]$s1.artist)).IndexOf((Normalize-AmText ([string]$expected.artist))) -ge 0) }
  $root2 = (Get-AmRoot $app.hwnd).root
  $all2 = @(); try { $all2 = $root2.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } catch { }
  $m2 = 0; foreach ($n in $all2) { try { if ((Normalize-AmText ([string]$n.Current.Name)) -eq (Normalize-AmText $plName)) { $m2++ } } catch { } }
  $o.steps.contextAfter = @{ playlistNameMatches = $m2 }
  if ($o.steps.match.titleMatch) { $o.verdict = 'PASS_CONTEXT' } elseif ($o.steps.match.artistMatch) { $o.verdict = 'PARTIAL_TITLE_DIFF' } else { $o.verdict = 'FAIL_CONTEXT_MISMATCH' }
}
$o.elapsedMs = [int]$sw.ElapsedMilliseconds
$json = ($o | ConvertTo-Json -Compress -Depth 8)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json