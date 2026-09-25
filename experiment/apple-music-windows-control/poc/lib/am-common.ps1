# ============================================================
# poc/lib/am-common.ps1
# Shared helpers for the Apple Music UI-Automation play experiment:
#   paths, timers, UTF-8 output, text normalization and matching rules.
#
# Ported/adapted from the verified PoC scripts:
#   recon/12-poc-uia-play-v2.ps1   (play + verify)
#   recon/13-latency-and-search.ps1 (per-stage timing)
# Logic is intentionally the same; only packaging and matching rules are new.
#
# ASCII-only on purpose (Windows PowerShell 5.1 parses BOM-less .ps1 as ANSI);
# any non-ASCII data (song titles) lives in poc/songs.json and is read as UTF-8.
# ============================================================

$script:AmPocDir = $PSScriptRoot | Split-Path -Parent
$script:AmExpDir = $script:AmPocDir | Split-Path -Parent
$script:AmFindingsDir = Join-Path $script:AmExpDir 'findings\poc'

function Get-AmPocDir { return $script:AmPocDir }
function Get-AmFindingsDir {
  if (-not (Test-Path $script:AmFindingsDir)) { New-Item -ItemType Directory -Force -Path $script:AmFindingsDir | Out-Null }
  return $script:AmFindingsDir
}
function Get-AmStamp { return (Get-Date).ToString('yyyyMMdd-HHmmss') }

# ---- time ----
function Get-AmNowMs {
  return [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds)
}
function Get-AmIsoNow { return [DateTime]::UtcNow.ToString('o') }
function Get-AmMsBetween([DateTime]$a, [DateTime]$b) { return [int]((New-TimeSpan $a $b).TotalMilliseconds) }
function Get-AmStopwatchMs($sw) { return [int]$sw.ElapsedMilliseconds }

# ---- UTF-8 output (no BOM: keeps JSON/CSV/text readable by every tool) ----
function Write-AmText([string]$path, [string]$text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}
function Write-AmJsonFile([string]$path, $obj) {
  Write-AmText $path ($obj | ConvertTo-Json -Depth 10)
}
function Add-AmJsonLine([string]$path, $obj) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::AppendAllText($path, (($obj | ConvertTo-Json -Compress -Depth 10) + "`r`n"), $enc)
}
function ConvertTo-AmJsonCompact($obj) { return ($obj | ConvertTo-Json -Compress -Depth 10) }

function Truncate-AmText([string]$s, [int]$max = 90) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  if ($s.Length -le $max) { return $s }
  return $s.Substring(0, $max)
}

# ============================================================
# Text normalization and matching
#
# Goal: never depend on localized decoration such as "Track 3" / CJK track
# prefixes / "song - artist" decorations. The song title is the primary key;
# the artist is only used to narrow down duplicates.
# ============================================================

# lowercase, full-width -> half-width, drop (feat ...) noise, keep letters and
# digits of any script (so CJK titles normalize correctly), collapse spaces.
function Normalize-AmText([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  $t = $s.ToLowerInvariant()
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $t.ToCharArray()) {
    $c = [int][char]$ch
    if ($c -ge 0xFF01 -and $c -le 0xFF5E) { [void]$sb.Append([char]($c - 0xFEE0)) }
    elseif ($c -eq 0x3000) { [void]$sb.Append(' ') }
    else { [void]$sb.Append($ch) }
  }
  $t = $sb.ToString()
  $t = $t -replace '\((feat|ft|with)[^)]*\)', ' '
  $t = $t -replace '\[(feat|ft|with)[^\]]*\]', ' '
  $t = $t -replace '\s*[-\u2013\u2014]\s*(remaster(ed)?|single version|album version|radio edit|live|explicit)\b.*$', ' '
  $t = $t -replace '[^\p{L}\p{Nd}]+', ' '
  $t = $t.Trim()
  $t = $t -replace '\s+', ' '
  return $t
}

# How well does a UI Automation row name match the wanted title?
#   3 = normalized equality
#   2 = row name starts with the title            (e.g. "How Do I ... Abel Tesfaye")
#   1 = title appears somewhere in the row name   (e.g. localized prefix in front)
#   0 = no match
function Get-AmTitleScore([string]$candidateName, [string]$title) {
  $n = Normalize-AmText $candidateName
  $t = Normalize-AmText $title
  if (-not $n -or -not $t) { return 0 }
  if ($n -eq $t) { return 3 }
  if ($n.StartsWith($t)) { return 2 }
  if ($n.Contains($t)) { return 1 }
  return 0
}

function Test-AmArtistInName([string]$candidateName, [string]$artist) {
  if ([string]::IsNullOrEmpty($artist)) { return $false }
  $n = Normalize-AmText $candidateName
  $a = Normalize-AmText $artist
  if (-not $n -or -not $a) { return $false }
  return $n.Contains($a)
}

# SMTC title comparison: tolerate suffixes like "(Remastered)" or a trailing
# "(feat. X)" but never accept a different song: the shorter normalized string
# must be a prefix of the longer one and cover at least 80% of it.
function Test-AmSmtcTitleMatch([string]$smtcTitle, [string]$targetTitle) {
  $a = Normalize-AmText $smtcTitle
  $b = Normalize-AmText $targetTitle
  if (-not $a -or -not $b) { return $false }
  if ($a -eq $b) { return $true }
  $short = $a; $long = $b
  if ($a.Length -gt $b.Length) { $short = $b; $long = $a }
  if (-not $long.StartsWith($short)) { return $false }
  $minLen = [int][math]::Floor($long.Length * 0.8)
  return ($short.Length -ge $minLen)
}

# Does the string contain CJK (so simplified/traditional variants are possible)?
function Test-AmHasCjk([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return $false }
  return ($s -match '[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]')
}

# SMTC artist comparison. Apple Music reports "artist + separator + album"
# (verified: "Abel Tesfaye <U+2014> Dawn FM"), so the wanted artist must appear
# inside the normalized reported value. For CJK names a character-overlap
# fallback is allowed because simplified/traditional variants of the same name
# (周杰伦 vs 周杰倫) would otherwise be rejected; Latin names stay strict so the
# check can never be loosened into accepting a different artist.
function Test-AmSmtcArtistMatch([string]$smtcArtist, [string]$targetArtist) {
  if ([string]::IsNullOrEmpty($targetArtist)) { return $true }   # nothing to check
  $a = Normalize-AmText $smtcArtist
  $b = Normalize-AmText $targetArtist
  if (-not $a -or -not $b) { return $false }
  if ($a -eq $b) { return $true }
  if ($a.StartsWith($b)) { return $true }
  if ($a.Contains($b)) { return $true }
  if ((Test-AmHasCjk $targetArtist) -or (Test-AmHasCjk $smtcArtist)) {
    $bb = $b -replace ' ', ''
    $aa = $a -replace ' ', ''
    if ($bb -and $aa) {
      $hits = 0
      foreach ($ch in $bb.ToCharArray()) { if ($aa.Contains([string]$ch)) { $hits++ } }
      if (($hits / $bb.Length) -ge 0.6) { return $true }
    }
  }
  return $false
}

# Loose artist comparison for catalog lookups: simplified/traditional Chinese
# variants of the same name share most characters (e.g. 周杰伦 vs 周杰倫) and no
# conversion table is available offline, so require a high character overlap.
# The fallback applies ONLY when a CJK string is involved: on Latin names the
# overlap is meaningless ("Ed Sheeran" vs "Fame on Fire" shares 6/9 characters).
function Test-AmArtistLooseMatch([string]$expected, [string]$actual, [double]$minRatio = 0.6) {
  if ([string]::IsNullOrEmpty($expected)) { return $true }
  if ([string]::IsNullOrEmpty($actual)) { return $false }
  if (Test-AmSmtcArtistMatch $actual $expected) { return $true }
  if (-not ((Test-AmHasCjk $expected) -or (Test-AmHasCjk $actual))) { return $false }
  $e = (Normalize-AmText $expected) -replace ' ', ''
  $a = (Normalize-AmText $actual) -replace ' ', ''
  if (-not $e -or -not $a) { return $false }
  $hits = 0
  foreach ($ch in $e.ToCharArray()) { if ($a.Contains([string]$ch)) { $hits++ } }
  return (($hits / $e.Length) -ge $minRatio)
}

# ---- song definitions (UTF-8 JSON, safe for CJK titles) ----
function Get-AmSongsPath { return (Join-Path $script:AmPocDir 'songs.json') }

function Read-AmSongs {
  $path = Get-AmSongsPath
  if (-not (Test-Path $path)) { throw ('songs.json not found: ' + $path) }
  $json = Get-Content -Path $path -Raw -Encoding UTF8
  return ($json | ConvertFrom-Json)
}

function Get-AmFrozenSongs {
  $cfg = Read-AmSongs
  $list = @()
  foreach ($s in $cfg.songs) {
    if ($s.title) { $list += $s }
  }
  return $list
}
