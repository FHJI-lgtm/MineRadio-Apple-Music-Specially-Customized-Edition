# Experiment B1: can a deep link start a USER PLAYLIST at a specified song and keep the list context?
# Identity comes from the Library API snapshot (poc-playlist-identity.json) - no UIA list scrolling here.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-smtc.ps1')
. (Join-Path $lib 'am-uia.ps1')
if (-not ('AmPocNative' -as [type])) {
  Add-Type -Namespace Poc -Name AmPocNative -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);' -ErrorAction SilentlyContinue
}
$id = Get-Content 'F:\mineradio-apple-music\experiment\apple-music-alpha1\integration\poc-playlist-identity.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$pl = [string]$id.playlist.id
$ti = 50   # 0-based -> the 51st song (middle of the list, far from the top)
$t = $id.tracks[$ti]
$nx = $id.tracks[$ti + 1]
$o = [ordered]@{ playlistLibraryId = $pl; targetIndex = ($ti + 1); targetName = [string]$t.name; targetLibrarySongId = [string]$t.id; targetCatalogSongId = [string]$t.catalogId; expectedNext = [string]$nx.name; candidates = @(); nextAfter = $null }
foreach ($url in @(
  ('https://music.apple.com/library/playlist/' + $pl + '?l=' + $t.id),
  ('https://music.apple.com/library/playlist/' + $pl + '?i=' + $t.catalogId)
)) {
  $nav = Invoke-AmNavigateUrl $url
  Start-Sleep -Seconds 12
  $s = Get-AmSmtcState
  $row = @{ url = $url; method = [string]$nav.method; gotTitle = [string]$s.title; gotArtist = [string]$s.artist; status = [string]$s.status; match = ([string]$s.title -eq [string]$t.name) }
  $o.candidates += $row
  if ($row.match) { $o.winningUrl = $url; break }
}
$sn = Get-AmSmtcState
if ([string]$sn.title -eq [string]$t.name) {
  try { [Poc.AmPocNative]::keybd_event(0xB0, 0, 0, [System.UIntPtr]::Zero); [Poc.AmPocNative]::keybd_event(0xB0, 0, 2, [System.UIntPtr]::Zero) } catch { }
  Start-Sleep -Seconds 9
  $s2 = Get-AmSmtcState
  $o.nextAfter = @{ expect = [string]$nx.name; got = [string]$s2.title; gotArtist = [string]$s2.artist; status = [string]$s2.status; match = ([string]$s2.title -eq [string]$nx.name) }
}
$o | ConvertTo-Json -Compress -Depth 6 | Write-Output