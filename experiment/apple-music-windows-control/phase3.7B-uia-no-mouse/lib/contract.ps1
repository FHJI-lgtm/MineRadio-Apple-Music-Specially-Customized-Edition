# ============================================================
# phase3.7B-uia-no-mouse/lib/contract.ps1
# Remaining UIA contract probing + the "which row is the main row" analysis.
#   * ItemContainerPattern (10019), ExpandCollapsePattern (10005), TogglePattern (10015)
#   * materialization census / diff around Realize and Select, looking for
#     Button / Hyperlink / Custom / SplitButton / ToggleButton / MenuItem that the
#     initial snapshot did not show
#   * anchor chain (row -> parent ListItem -> List -> ListView) and child scan
# Everything is observation only: no mouse, no foreground call, no keyboard.
# ASCII-only.
# ============================================================

. (Join-Path $PSScriptRoot 'patterns.ps1')

$script:AmNmActionTypes = @('ControlType.Button', 'ControlType.Hyperlink', 'ControlType.Custom', 'ControlType.SplitButton', 'ControlType.ToggleButton', 'ControlType.MenuItem', 'ControlType.Image')

function Get-AmNmCensus($root, [int]$SampleCap = 25) {
  $res = [ordered]@{ nodes = 0; counts = [ordered]@{}; actionElements = @(); actionCount = 0 }
  try {
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $res.nodes = $all.Count
    foreach ($el in $all) {
      $ct = ''; $nm = ''
      try { $ct = '' + $el.Current.ControlType.ProgrammaticName; $nm = '' + $el.Current.Name } catch { continue }
      if ($res.counts.Contains($ct)) { $res.counts[$ct] = $res.counts[$ct] + 1 } else { $res.counts[$ct] = 1 }
      if ($script:AmNmActionTypes -contains $ct) {
        $res.actionCount++
        if ($res.actionElements.Count -lt $SampleCap) {
          $res.actionElements += , [ordered]@{ controlType = $ct; name = $nm; automationId = ('' + $el.Current.AutomationId); className = ('' + $el.Current.ClassName); bounds = ('' + [int]$el.Current.BoundingRectangle.Width + 'x' + [int]$el.Current.BoundingRectangle.Height) }
        }
      }
    }
  } catch { $res['error'] = $_.Exception.Message }
  return $res
}

function Get-AmNmCensusDiff($before, $after) {
  $d = [ordered]@{ actionCountBefore = $before.actionCount; actionCountAfter = $after.actionCount
                   nodeDelta = ([int]$after.nodes - [int]$before.nodes); newActionElements = @(); typeDelta = [ordered]@{} }
  $bk = @{}
  foreach ($a in $before.actionElements) { $bk[('' + $a.controlType + '|' + $a.name)] = $true }
  foreach ($a in $after.actionElements) { if (-not $bk.ContainsKey(('' + $a.controlType + '|' + $a.name))) { $d.newActionElements += , $a } }
  foreach ($k in $after.counts.Keys) {
    $b = 0; if ($before.counts.Contains($k)) { $b = [int]$before.counts[$k] }
    $delta = [int]$after.counts[$k] - $b
    if ($delta -ne 0) { $d.typeDelta[$k] = $delta }
  }
  return $d
}

function Get-AmNmAnchorChain($el, [int]$Depth = 6) {
  $chain = @()
  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $cur = $el
    for ($i = 1; $i -le $Depth; $i++) {
      $cur = $walker.GetParent($cur)
      if ($cur -eq $null) { break }
      $info = Get-AmNmElementInfo $cur
      $info['depth'] = $i
      $chain += , $info
    }
  } catch { }
  return $chain
}

function Get-AmNmChildScan($el, [int]$Depth = 2, [int]$Cap = 200) {
  $out = [ordered]@{ actionChildren = @(); listItemChildren = 0; textChildren = 0; scanned = 0 }
  try {
    $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($c in $all) {
      $out.scanned++
      if ($out.scanned -gt $Cap) { break }
      $ct = ''; $nm = ''
      try { $ct = '' + $c.Current.ControlType.ProgrammaticName; $nm = '' + $c.Current.Name } catch { continue }
      if ($script:AmNmActionTypes -contains $ct) {
        $out.actionChildren += , [ordered]@{ controlType = $ct; name = $nm; automationId = ('' + $c.Current.AutomationId); className = ('' + $c.Current.ClassName) }
      }
      if ($ct -eq 'ControlType.ListItem') { $out.listItemChildren++ }
      if ($ct -eq 'ControlType.Text') { $out.textChildren++ }
    }
  } catch { }
  return $out
}

# Which of the title-matching rows is the real song row?
function Get-AmNmRowAnalysis($root, [string]$Title, [string]$Artist) {
  $out = [ordered]@{ rows = @(); mainRowGuess = ''; reasoning = @() }
  $found = Find-AmNmTargetElements $root $Title $Artist
  $idx = 0
  foreach ($m in $found.listItemMatches) {
    $idx++
    $chain = Get-AmNmAnchorChain $m.element 4
    $child = Get-AmNmChildScan $m.element 1
    $pat = Get-AmNmPatternInventory $m.element
    $out.rows += , [ordered]@{
      ordinal = $idx; name = $m.name; automationId = $m.automationId; className = $m.className
      bounds = $m.bounds; boundsWidth = $m.boundsWidth; isOffscreen = $m.isOffscreen; isEnabled = $m.isEnabled
      patterns = @($pat.available); actionChildren = @($child.actionChildren); listItemChildren = $child.listItemChildren; textChildren = $child.textChildren
      anchorClasses = @($chain | ForEach-Object { $_.className }); anchorTypes = @($chain | ForEach-Object { $_.controlType })
    }
  }
  $out.reasoning += ('title-matching ListItems: ' + $out.rows.Count + ' of ' + $found.listItemTotal + ' total on the page')
  $geom = @($out.rows | Where-Object { $_.boundsWidth -gt 0 })
  $out.reasoning += ('rows with geometry at snapshot time: ' + $geom.Count)
  $withPlay = @($out.rows | Where-Object { $_.actionChildren.Count -gt 0 })
  $out.reasoning += ('rows exposing internal action children: ' + $withPlay.Count)
  if ($withPlay.Count -eq 1) { $out.mainRowGuess = ('ordinal ' + $withPlay[0].ordinal); $out.reasoning += 'exactly one row exposes an internal action element' }
  elseif ($geom.Count -eq 1) { $out.mainRowGuess = ('ordinal ' + $geom[0].ordinal); $out.reasoning += 'exactly one row has geometry' }
  else { $out.mainRowGuess = 'ambiguous'; $out.reasoning += 'no single row is distinguishable by geometry or internal action children' }
  return $out
}

# ---- remaining patterns ------------------------------------------------------
function Test-AmNmPatternSupport($el, [int]$PatternId) {
  $res = @{ id = $PatternId; resolvable = $false; supported = $false; error = '' }
  $pat = Get-AmNmPatternRef $PatternId
  if ($pat -eq $null) { return $res }
  $res.resolvable = $true
  $obj = $null
  try { $res.supported = [bool]$el.TryGetCurrentPattern($pat, [ref]$obj) } catch { $res.error = $_.Exception.Message }
  return $res
}

function Invoke-AmNmItemContainerProbe($listElement, [string]$Title) {
  $res = [ordered]@{ patternId = 10019; resolvable = $false; supported = $false; findByName = 'not-attempted'
                     foundName = ''; foundClass = ''; foundAutomationId = ''; error = '' }
  $pat = Get-AmNmPatternRef 10019
  if ($pat -eq $null) { return $res }
  $res.resolvable = $true
  $obj = $null
  if (-not $listElement.TryGetCurrentPattern($pat, [ref]$obj)) { return $res }
  $res.supported = $true
  try {
    $nameProp = [System.Windows.Automation.AutomationElement]::NameProperty
    $found = $obj.FindItemByProperty($null, $nameProp, $Title)
    if ($found -eq $null) { $res.findByName = 'no-match' }
    else {
      $res.findByName = 'match'
      $res.foundName = '' + $found.Current.Name
      $res.foundClass = '' + $found.Current.ClassName
      $res.foundAutomationId = '' + $found.Current.AutomationId
    }
  } catch { $res.error = $_.Exception.Message }
  return $res
}
