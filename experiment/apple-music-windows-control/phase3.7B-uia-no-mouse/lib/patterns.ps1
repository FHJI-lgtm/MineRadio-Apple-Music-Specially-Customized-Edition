# ============================================================
# phase3.7B-uia-no-mouse/lib/patterns.ps1
# UIA Pattern inventory.  Distinguishes, per element and per pattern:
#   exists            - TryGetCurrentPattern returned an object
#   supportsAction    - the pattern exposes an action that could cause a state change
#   (action succeeded / caused navigation / caused playback are recorded by the
#    activation runner, NOT here - existence is never treated as usability)
#
# Patterns are resolved by their UIA identifier through AutomationPattern.LookupById
# because some pattern WRAPPER TYPES (LegacyIAccessiblePattern in particular) are not
# present in this machine's .NET, which previously made the whole inventory fail.
# ASCII-only.
# ============================================================

. (Join-Path $PSScriptRoot 'instrumentation.ps1')

# UIA pattern ids (UIAutomationClient.h)
function Get-AmNmPatternMap {
  return [ordered]@{
    InvokePattern            = @{ id = 10000; action = 'Invoke' }
    SelectionPattern         = @{ id = 10001; action = 'container-selection' }
    ValuePattern             = @{ id = 10002; action = 'SetValue' }
    RangeValuePattern        = @{ id = 10003; action = 'SetValue' }
    ScrollPattern            = @{ id = 10004; action = 'Scroll' }
    ExpandCollapsePattern    = @{ id = 10005; action = 'Expand/Collapse' }
    GridPattern              = @{ id = 10006; action = 'grid' }
    GridItemPattern          = @{ id = 10007; action = 'grid' }
    TablePattern             = @{ id = 10008; action = 'table' }
    TableItemPattern         = @{ id = 10009; action = 'table' }
    SelectionItemPattern     = @{ id = 10010; action = 'Select' }
    WindowPattern            = @{ id = 10013; action = 'window' }
    TextPattern              = @{ id = 10014; action = 'text' }
    TogglePattern            = @{ id = 10015; action = 'Toggle' }
    TransformPattern         = @{ id = 10016; action = 'move/resize' }
    ScrollItemPattern        = @{ id = 10017; action = 'ScrollIntoView' }
    LegacyIAccessiblePattern = @{ id = 10018; action = 'DoDefaultAction/Select' }
    VirtualizedItemPattern   = @{ id = 10020; action = 'Realize' }
  }
}

function Get-AmNmPatternRef([int]$Id) {
  try { return [System.Windows.Automation.AutomationPattern]::LookupById($Id) } catch { return $null }
}

function Get-AmNmElementInfo($el) {
  if ($el -eq $null) { return $null }
  $i = [ordered]@{ controlType = ''; name = ''; automationId = ''; className = ''; frameworkId = ''
                   isEnabled = $false; isOffscreen = $false; hasKeyboardFocus = $false; isControlElement = $false
                   nativeWindowHandle = 0; processId = 0; bounds = ''; boundsWidth = 0; boundsHeight = 0; error = '' }
  try {
    $c = $el.Current
    $i.controlType = '' + $c.ControlType.ProgrammaticName
    $i.name = '' + $c.Name
    $i.automationId = '' + $c.AutomationId
    $i.className = '' + $c.ClassName
    $i.frameworkId = '' + $c.FrameworkId
    $i.isEnabled = $c.IsEnabled
    $i.isOffscreen = $c.IsOffscreen
    $i.hasKeyboardFocus = $c.HasKeyboardFocus
    $i.isControlElement = $c.IsControlElement
    $i.nativeWindowHandle = [int64]$c.NativeWindowHandle
    $i.processId = [int]$c.ProcessId
    $r = $c.BoundingRectangle
    $i.bounds = ('' + [int]$r.Left + ',' + [int]$r.Top + ',' + [int]$r.Right + ',' + [int]$r.Bottom)
    $i.boundsWidth = [int]$r.Width
    $i.boundsHeight = [int]$r.Height
  } catch { $i.error = $_.Exception.Message }
  return $i
}

function Get-AmNmPatternInventory($el) {
  $res = [ordered]@{ available = @(); unavailable = @(); typeUnavailable = @(); details = [ordered]@{}; actionCapable = @(); availableCount = 0 }
  if ($el -eq $null) { return $res }
  $map = Get-AmNmPatternMap
  foreach ($k in $map.Keys) {
    $entry = $map[$k]
    $d = [ordered]@{ id = $entry.id; exists = $false; action = $entry.action; supportsAction = $false; extra = '' }
    $pat = Get-AmNmPatternRef $entry.id
    if ($pat -eq $null) { $res.typeUnavailable += $k; $d.extra = 'pattern-id-not-resolvable' }
    else {
      $obj = $null
      $ok = $false
      try { $ok = $el.TryGetCurrentPattern($pat, [ref]$obj) } catch { $ok = $false }
      $d.exists = [bool]$ok
      $d.supportsAction = [bool]$ok
      if ($ok -and $k -eq 'LegacyIAccessiblePattern') {
        try {
          $da = '' + $obj.Current.DefaultAction
          $st = '' + $obj.Current.State
          $nm = '' + $obj.Current.Name
          $d.extra = ('defaultAction=[' + $da + '] state=' + $st + ' name=[' + $nm + ']')
        } catch { $d.extra = 'legacy-read-error' }
      }
      if ($ok -and $k -eq 'ValuePattern') {
        try { $d.extra = ('value=[' + $obj.Current.Value + '] readonly=' + $obj.Current.IsReadOnly) } catch { $d.extra = 'value-read-error' }
      }
    }
    $res.details[$k] = $d
    if ($d.exists) { $res.available += $k; if ($d.supportsAction) { $res.actionCapable += $k } } else { $res.unavailable += $k }
  }
  $res.availableCount = $res.available.Count
  return $res
}

# Locates the elements that could represent the target row on the current page.
function Find-AmNmTargetElements($root, [string]$Title, [string]$Artist, [int]$NodeCap = 6000) {
  $out = [ordered]@{ ok = $false; error = ''; nodes = 0; listItemMatches = @(); listItemTotal = 0
                     textMatches = @(); buttonCandidates = @(); allButtons = 0; artistNodeSeen = $false }
  try {
    if ($root -eq $null) { $out.error = 'no-root'; return $out }
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $out.nodes = $all.Count
    $n = 0
    foreach ($el in $all) {
      $n++
      if ($n -gt $NodeCap) { break }
      $ct = ''; $nm = ''
      try { $ct = '' + $el.Current.ControlType.ProgrammaticName; $nm = '' + $el.Current.Name } catch { continue }
      if ($nm -eq '') { continue }
      if ((-not $out.artistNodeSeen) -and $Artist -ne '' -and (Test-AmNmTextMatch $Artist $nm)) { $out.artistNodeSeen = $true }
      $titleHit = Test-AmNmTextMatch $Title $nm
      if ($ct -eq 'ControlType.ListItem') {
        $out.listItemTotal++
        if ($titleHit) {
          $info = Get-AmNmElementInfo $el
          $info['element'] = $el
          $out.listItemMatches += , $info
        }
      } elseif ($titleHit) {
        $info = Get-AmNmElementInfo $el
        $info['element'] = $el
        $out.textMatches += , $info
      }
      if ($ct -in @('ControlType.Button', 'ControlType.Hyperlink', 'ControlType.Image')) {
        $out.allButtons++
        if ($titleHit -or $nm -like '*Play*') {
          $info = Get-AmNmElementInfo $el
          $info['element'] = $el
          $out.buttonCandidates += , $info
        }
      }
    }
    $out.ok = $true
  } catch { $out.error = $_.Exception.Message }
  return $out
}
