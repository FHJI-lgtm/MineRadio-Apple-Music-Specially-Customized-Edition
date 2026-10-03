# T-E: READ-ONLY enumeration of the Apple Music UIA tree for a playlist identity signal.
# No click, no playback, no input injection, no scroll API.
param([string]$TargetsFile, [string]$OutFile, [int]$MaxNodes = 5000)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lib = 'F:\mineradio-apple-music\experiment\apple-music-windows-control\poc\lib'
. (Join-Path $lib 'am-common.ps1')
. (Join-Path $lib 'am-uia.ps1')
$t = Get-Content $TargetsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$names = @($t.playlists | ForEach-Object { $_.name }) | Select-Object -Unique
$ids = @($t.playlists | ForEach-Object { $_.id })
$o = [ordered]@{ stage = ''; clientVersion = ''; nodeCount = 0; targets = $t.playlists; nameMatches = @(); automationIds = @(); verdict = ''; signals = @() }
$pk = Get-Process AppleMusic -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pk) { $o.stage = 'BLOCKED_APPLE_MUSIC_NOT_RUNNING'; }
else {
  try { $o.clientVersion = (Get-AppxPackage *AppleMusic* | Select-Object -First 1).Version } catch { }
  $rootRes = Get-AmRoot $pk.MainWindowHandle
  if (-not $rootRes.ok) { $o.stage = 'NO_UIA_ROOT' } else {
    $o.stage = 'ENUMERATED'
    $all = @()
    try { $all = @($rootRes.root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) } catch { }
    if ($all.Count -gt $MaxNodes) { $all = @($all[0..($MaxNodes - 1)]) }
    $o.nodeCount = $all.Count
    $aidSet = @{}
    foreach ($n in $all) {
      try {
        $nm = [string]$n.Current.Name
        $aid = [string]$n.Current.AutomationId
        if ($aid) { $aidSet[$aid] = $true }
        if (-not $nm) { continue }
        $hit = $false
        foreach ($want in $names) { if ($nm.Trim() -eq ([string]$want).Trim()) { $hit = $true; break } }
        if (-not $hit) { continue }
        $ct = ''; $cls = ''; $fw = ''; $rid = ''; $rect = ''; $lct = ''; $help = ''; $stat = ''; $acc = ''
        try { $ct = [string]$n.Current.ControlType.ProgrammaticName } catch { }
        try { $cls = [string]$n.Current.ClassName } catch { }
        try { $fw = [string]$n.Current.FrameworkId } catch { }
        try { $rid = ($n.GetRuntimeId() -join '.') } catch { }
        try { $r = $n.Current.BoundingRectangle; $rect = ('' + [int]$r.Left + ',' + [int]$r.Top + ' ' + [int]$r.Width + 'x' + [int]$r.Height) } catch { }
        try { $lct = [string]$n.Current.LocalizedControlType } catch { }
        try { $help = [string]$n.Current.HelpText } catch { }
        try { $stat = [string]$n.Current.ItemStatus } catch { }
        try { $acc = [string]$n.Current.AcceleratorKey } catch { }
        $anc = @()
        $cur = $n
        for ($d = 0; $d -lt 5 -and $cur; $d++) {
          try { $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur) } catch { $cur = $null }
          if ($cur) { try { $an = [string]$cur.Current.Name; $aa = [string]$cur.Current.AutomationId; $anc += (('' + $an).Trim() + '#' + $aa) } catch { } }
        }
        $o.nameMatches += @{ name = $nm; automationId = $aid; controlType = $ct; localizedControlType = $lct; className = $cls; frameworkId = $fw; runtimeId = $rid; rect = $rect; helpText = $help; itemStatus = $stat; acceleratorKey = $acc; ancestors = @($anc) }
      } catch { }
    }
    $keys = @($aidSet.Keys)
    $o.automationIds = @($keys | Sort-Object | Select-Object -First 80)
    # signal assessment: compare same-named items field by field; check traceability to any p.* id
    $groups = @{}
    foreach ($m in $o.nameMatches) { if (-not $groups.ContainsKey($m.name)) { $groups[$m.name] = @() } ; $groups[$m.name] += $m }
    $fields = @('automationId','controlType','className','frameworkId','runtimeId','rect','helpText','itemStatus','acceleratorKey')
    foreach ($f in $fields) {
      $vals = @()
      foreach ($k in $groups.Keys) { foreach ($m in $groups[$k]) { $vals += [string]$m[$f] } }
      $distinct = @($vals | Sort-Object -Unique)
      $trace = $false
      foreach ($v in $distinct) { foreach ($id in $ids) { if ($v -and ([string]$v).IndexOf([string]$id) -ge 0) { $trace = $true } } }
      $o.signals += @{ field = $f; distinctValues = @($distinct | Select-Object -First 6); distinguishesSameName = ($distinct.Count -gt 1); traceableToPlaylistId = $trace; grade = $(if ($trace) { 'DIRECT' } else { 'INFERRED' }); qualified = ($trace -and $distinct.Count -gt 1) }
    }
    $qualified = @($o.signals | Where-Object { $_.qualified })
    if ($qualified.Count -gt 0) { $o.verdict = 'T-E PASS' } else { $o.verdict = 'T-E FAIL' }
  }
}
$json = ($o | ConvertTo-Json -Compress -Depth 8)
$json | Out-File -FilePath $OutFile -Encoding utf8
Write-Output $json