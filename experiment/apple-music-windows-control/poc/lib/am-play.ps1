# ============================================================
# poc/lib/am-play.ps1
# The playSong engine: ensure app -> locate the song -> realize the row ->
# safe-area double click -> SMTC verification. Shared by play-song.ps1 (CLI),
# discover-songs.ps1, stability-test.ps1 and scenario-test.ps1 so there is only
# one implementation and no cross-process (encoding-unfriendly) argument passing.
#
# Two locate modes:
#   mode=deeplink (preferred, verified): open the song URL, wait for the page to
#       expose the track row WITH geometry, then double click that row. Opening
#       the URL is navigation only - it is never treated as success.
#   mode=search (fallback): drive the search box via UI Automation. Kept because
#       a caller may not know the song URL, but measured to be less reliable: the
#       search-results cards navigate instead of playing and the song rows are
#       often not materialized (see findings/poc phase report).
#
# Stage codes:
#   APP_NOT_RUNNING, AM_UI_NOT_FOUND, SEARCH_FAILED, RESULT_NOT_FOUND,
#   REALIZE_FAILED, BOUNDS_INVALID, OUT_OF_VIEW, CLICK_FAILED,
#   SMTC_TIMEOUT      = playback never entered Playing      (click did nothing)
#   SMTC_WRONG_TRACK  = Playing but a different song        (click/switch raced)
#   PRECONDITION_PAUSE_FAILED = only with -PauseFirst, session stayed Playing
#
# ASCII-only on purpose.
# ============================================================

# Minimize the Apple Music window (SW_MINIMIZE = 6) so the automation does not leave it in front
# of the user.  Called only after the song click has landed: SMTC verification is a system API and
# does not need the window visible, and every retry attempt restores/foregrounds the window first.
function Minimize-AmWindow([IntPtr]$Hwnd) {
  if (-not $Hwnd -or $Hwnd -eq [IntPtr]::Zero) { return $false }
  if (-not ('AmPlayNative.Win' -as [type])) {
    Add-Type -Namespace AmPlayNative -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' | Out-Null
  }
  try { [void][AmPlayNative.Win]::ShowWindow($Hwnd, 6); return $true } catch { return $false }
}
function Invoke-AmPlaySong {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Artist = '',
    [string]$SongId = '',
    [string]$Url = '',
    [int]$TimeoutMs = 6000,
    [int]$Retries = 2,
    [int]$SearchWaitMs = 6000,
    [int]$PageWaitMs = 12000,
    [switch]$PauseFirst,
    [switch]$NoLaunch,
    [switch]$NoForeground,   # test-only: measure whether foregrounding is required
    [string]$ShotPath = ''
  )

  $result = @{
    ok = $false; stage = 'UNKNOWN'; stageDetail = ''; stageHistory = @()
    title = $Title; artist = $Artist; songId = $SongId; mode = ''
    attempts = 0; appLaunched = $false; searchAlreadyOpen = $false; searchSubmitted = $false
    ambiguous = $false; candidateCount = 0; pickedByPosition = $false; artistFiltered = $false
    matchedRow = ''; competitors = @(); clickPoint = ''; rect = ''; clickRecomputed = $false
    triedCandidates = @(); candidatesDetail = @(); firstCandidateFailedButPlayed = $false
    window = @{ restored = $false; before = @{}; after = @{} }
    baseline = @{ status = ''; title = ''; artist = ''; hasSession = $false }
    smtc = @{ title = ''; artist = ''; status = ''; pos = ''; posMs = 0; sawPlaying = $false; sawPlayingWrong = $false; firstWrongMs = $null; wrongTitles = @(); statuses = @(); hasSession = $false }
    t = @{ ensureAppMs = 0; uiRootMs = 0; searchMs = 0; settleMs = 0; listMs = 0; selectMs = 0; realizeMs = 0; clickMs = 0; smtcMs = 0; e2eMs = 0 }
    ts = (Get-AmIsoNow); tsMs = (Get-AmNowMs)
  }

  # ---- optional precondition: pause + short settle BEFORE timing starts ----
  if ($PauseFirst) {
    [void](Invoke-AmPause)
    $settle = Wait-AmSmtcSettled 1500
    if (-not $settle.settled) {
      $result.stage = 'PRECONDITION_PAUSE_FAILED'
      $result.stageDetail = ('still ' + $settle.state.status + ' after pause, waited ' + $settle.waitedMs + 'ms')
      $result.smtc.title = $settle.state.title
      $result.smtc.artist = $settle.state.artist
      $result.smtc.status = $settle.state.status
      $result.stageHistory = @('PRECONDITION_PAUSE_FAILED')
      $result.ts = (Get-AmIsoNow); $result.tsMs = (Get-AmNowMs)
      return $result
    }
    $result.baseline = @{ status = $settle.state.status; title = $settle.state.title; artist = $settle.state.artist; hasSession = $settle.state.ok }
  }

  $totalSw = [Diagnostics.Stopwatch]::StartNew()
  $hwnd = [IntPtr]::Zero
  $triedIndexes = @()

  for ($attempt = 0; $attempt -le $Retries; $attempt++) {
    $result.attempts = $attempt + 1
    $a = @{ ensureAppMs = 0; uiRootMs = 0; searchMs = 0; settleMs = 0; listMs = 0; selectMs = 0; realizeMs = 0; clickMs = 0; smtcMs = 0; e2eMs = 0 }
    $stage = 'UNKNOWN'; $detail = ''; $pick = $null; $items = @()
    $sw = [Diagnostics.Stopwatch]::StartNew()

    # ---- 1. app running (launch when needed, unless -NoLaunch) ----
    if ($NoLaunch) {
      $p = Get-AmProcess
      if ($p -and $p.MainWindowHandle -ne 0) { $app = @{ ok = $true; launched = $false; ensureAppMs = 0 } ; $hwnd = $p.MainWindowHandle }
      else { $app = @{ ok = $false; launched = $false; ensureAppMs = 0 } }
    } else {
      $app = Ensure-AmRunning 30000
    }
    $a.ensureAppMs = $app.ensureAppMs
    if (-not $app.ok) { $stage = 'APP_NOT_RUNNING'; $detail = ('launched=' + $app.launched + ' noLaunch=' + [bool]$NoLaunch) }
    else {
      if (-not $NoLaunch) { $hwnd = $app.hwnd }
      if ($app.launched) { $result.appLaunched = $true; Start-Sleep -Milliseconds 800 }

      # ---- 1b. a minimized window has no UIA geometry ----
      $win = Restore-AmWindow $hwnd
      $result.window = @{ restored = $win.restored; before = $win.before; after = $win.after }
      # the window must be foreground before any UIA geometry / click work
      if (-not $NoForeground) {
        Invoke-AmForeground $hwnd
        Start-Sleep -Milliseconds 200
      }

      # ---- 2. UIA root ----
      $rootRes = Get-AmRoot $hwnd
      $a.uiRootMs = [Math]::Max(0, ([int]$sw.ElapsedMilliseconds - $a.ensureAppMs))
      if (-not $rootRes.ok) { $stage = 'AM_UI_NOT_FOUND'; $detail = ('tries=' + $rootRes.tries) }
      else {
        $root = $rootRes.root

        # ---- 3. locate the song ----
        if ($Url) {
          $result.mode = 'deeplink'
          $tPage = [Diagnostics.Stopwatch]::StartNew()
          $sigBefore = Get-AmTreeSignature $root
          $nav = Invoke-AmNavigateUrl $Url
          $result.navMethod = $nav.method
          $navigated = $false
          $contentTitle = $false; $contentArtist = $false; $contentMatchMs = -1
          $pick = $null; $items = @()
          $normTitle = Normalize-AmText $Title
          # Materialize budget for long album/playlist pages (see below).
          $materializeSteps = 0
          $maxMaterializeSteps = 8
          $materializeIntervalMs = 1000
          $nextMaterializeMs = $materializeIntervalMs
          do {
            Start-Sleep -Milliseconds 300
            $items = Get-AmListItems $root
            $sigNow = Get-AmTreeSignature $root
            if ($sigNow -ne $sigBefore) { $navigated = $true }
            # Phase 3.7A fix: the structural signature alone must never decide that the
            # navigation failed.  Two different Apple Music pages can share a shape, so a
            # successful navigation used to be reported as "page unchanged".  The page is
            # now also considered navigated when the TARGET CONTENT is visible, with an
            # identity constraint: normalized title AND artist - never the title alone.
            # This only feeds the success criterion; the loop still ends on a realizable
            # row with geometry, so a half-rendered page can never cut the wait short and
            # no fixed sleep is added (the polling and the 12s cap are unchanged).
            $contentTitle = $false; $contentArtist = $false
            try {
              $allNodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
              foreach ($nd in $allNodes) {
                $nm = ''
                try { $nm = '' + $nd.Current.Name } catch { $nm = '' }
                if ($nm -eq '') { continue }
                if (-not $contentTitle) {
                  $nn = Normalize-AmText $nm
                  if ($nn -and $normTitle -and (($nn -eq $normTitle) -or $nn.StartsWith($normTitle))) { $contentTitle = $true }
                }
                if ((-not $contentArtist) -and $Artist -and (Test-AmArtistInName $nm $Artist)) { $contentArtist = $true }
                if ($contentTitle -and ($contentArtist -or (-not $Artist))) { break }
              }
            } catch { }
            if ($contentTitle -and ($contentArtist -or (-not $Artist))) {
              $navigated = $true
              if ($contentMatchMs -lt 0) { $contentMatchMs = [int]$tPage.ElapsedMilliseconds }
            }
            $pick = Select-AmCandidateWithGeometry $items $Title $Artist
            $a.listMs = [int]$tPage.ElapsedMilliseconds
            if ($pick.ok -and $pick.hadGeometry) { break }
            # Materialize step: on a long album or playlist page the target row can sit below the
            # viewport and therefore not exist in the UIA tree at all (virtualized list), in which
            # case no amount of waiting can ever find it.  Advance the list with the chain own wheel
            # scroll (Scroll-AmView, already part of this chain) in a bounded number of downward
            # steps and re-scan each iteration.  Never scrolls upward, never extends the 12s cap.
            if ($hwnd -and $hwnd -ne [IntPtr]::Zero -and $materializeSteps -lt $maxMaterializeSteps -and $tPage.ElapsedMilliseconds -ge $nextMaterializeMs) {
              Scroll-AmView $hwnd -1 3
              $materializeSteps++
              try { $a.materializeSteps = $materializeSteps } catch { }
              $nextMaterializeMs = [int]$tPage.ElapsedMilliseconds + $materializeIntervalMs
            }
          } while ($tPage.ElapsedMilliseconds -lt $PageWaitMs)
          $a.settleMs = [int]$tPage.ElapsedMilliseconds
          $result.navigated = $navigated
          $result.contentTitleVisible = $contentTitle
          $result.contentArtistVisible = $contentArtist
          $result.contentMatchMs = $contentMatchMs
          if (-not ($pick -and $pick.ok -and $pick.hadGeometry)) {
            if (-not $navigated) {
              $stage = 'URL_NAVIGATION_FAILED'
              $detail = ('page unchanged within ' + $PageWaitMs + 'ms (nav=' + $nav.method + ') listItems=' + $items.Count + ' contentTitle=' + $contentTitle + ' contentArtist=' + $contentArtist)
            } else {
              $stage = 'TARGET_ROW_NOT_FOUND'
              $detail = ('page changed but no row matched "' + $Title + '" (listItems=' + $items.Count + ')')
            }
          }
        } else {
          $result.mode = 'search'
          $sr = Invoke-AmSearch $root $Title $hwnd
          $a.searchMs = $sr.ms
          $result.searchAlreadyOpen = $sr.alreadyOpen
          $result.searchSubmitted = $sr.submitted
          if (-not $sr.ok) { $stage = 'SEARCH_FAILED'; $detail = $sr.detail }
          else {
            $tWait = [Diagnostics.Stopwatch]::StartNew()
            do {
              $tList = [Diagnostics.Stopwatch]::StartNew()
              $items = Get-AmListItems $root
              $a.listMs = [int]$tList.ElapsedMilliseconds
              $tSel = [Diagnostics.Stopwatch]::StartNew()
              $pick = Select-AmCandidate $items $Title $Artist
              $a.selectMs = [int]$tSel.ElapsedMilliseconds
              if ($pick.ok) { break }
              Start-Sleep -Milliseconds 250
            } while ($tWait.ElapsedMilliseconds -lt $SearchWaitMs)
            $a.settleMs = [int]$tWait.ElapsedMilliseconds
            if (-not $pick.ok) { $stage = 'RESULT_NOT_FOUND'; $detail = ('listItems=' + $items.Count) }
          }
        }

        # ---- 4. choose a candidate and act on it ----
        if ($stage -eq 'UNKNOWN' -and $pick -and $pick.ok) {
          $result.candidateCount = $pick.candidateCount
          $result.ambiguous = $pick.ambiguous
          $result.pickedByPosition = $pick.pickedByPosition
          $result.artistFiltered = $pick.artistFiltered
          $result.competitors = $pick.competitors
          $result.candidatesDetail = @($pick.candidates | ForEach-Object { @{ name = (Truncate-AmText $_.name 90); titleScore = $_.titleScore; artistHit = $_.artistHit; rank = $_.rank; selectionItem = $_.selectionItem; invoke = $_.invoke } })

          # Search mode only: the search-results view navigates instead of playing,
          # so activate the best result to open the song's page and then play the
          # track row there (the page row is the click target verified in the PoC).
          if ($result.mode -eq 'search') {
            $navCand = $null
            foreach ($c in $pick.candidates) {
              $r = $null
              try { $r = $c.element.Current.BoundingRectangle } catch { $r = $null }
              if ($r -and -not $r.IsEmpty) { $navCand = $c; break }
            }
            if ($navCand) {
              $navSw = [Diagnostics.Stopwatch]::StartNew()
              $invoked = $false
              try { $navCand.element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $invoked = $true } catch { $invoked = $false }
              if (-not $invoked) {
                $nr = $navCand.element.Current.BoundingRectangle
                $npt = Get-AmSafeClickPoint $nr
                [void](Invoke-AmRowPlay $hwnd $navCand.element $npt.x $npt.y)
              }
              $result.navigatedBy = $(if ($invoked) { 'invoke' } else { 'click' })
              # wait for the opened page to expose the track row
              do {
                Start-Sleep -Milliseconds 400
                $pageItems = Get-AmListItems $root
                $pagePick = Select-AmCandidateWithGeometry $pageItems $Title $Artist
                if ($pagePick.ok -and $pagePick.hadGeometry) { $pick = $pagePick; break }
              } while ($navSw.ElapsedMilliseconds -lt $PageWaitMs)
              $result.navigateMs = [int]$navSw.ElapsedMilliseconds
              if ($pagePick -and $pagePick.ok -and $pagePick.hadGeometry) {
                $result.candidateCount = $pick.candidateCount
                $result.ambiguous = $pick.ambiguous
                $result.candidatesDetail = @($pick.candidates | ForEach-Object { @{ name = (Truncate-AmText $_.name 90); titleScore = $_.titleScore; artistHit = $_.artistHit; rank = $_.rank; selectionItem = $_.selectionItem; invoke = $_.invoke } })
              } else {
                $result.pageRowFound = $false
              }
            }
          }

          $cand = $null
          foreach ($c in $pick.candidates) {
            if ($triedIndexes -notcontains $c.index) { $cand = $c; break }
          }
          if (-not $cand) { $cand = $pick.candidates[0] }
          $triedIndexes = @($triedIndexes) + @($cand.index)
          $result.matchedRow = $cand.name
          $result.triedCandidates = @($result.triedCandidates) + @(Truncate-AmText $cand.name 90)
          if ($attempt -gt 0 -and $result.triedCandidates.Count -gt 1) { $result.firstCandidateFailedButPlayed = $true }

          # ---- 5. realize the row, scrolling it into the viewport if needed ----
          $rz = Realize-AmRow $cand.element 2000 100 $hwnd 6
          $a.realizeMs = $rz.ms
          $result.realizeSteps = $rz.steps
          if ($rz.visibility) { $result.rectVisibility = @{ ratio = [math]::Round($rz.visibility.ratio, 2); clickable = $rz.visibility.clickable; side = $rz.visibility.side } }
          if (-not $rz.ok) {
            $stage = $rz.stage
            if ($rz.rect) { $result.rect = ('' + [int]$rz.rect.Left + ',' + [int]$rz.rect.Top + ' ' + [int]$rz.rect.Width + 'x' + [int]$rz.rect.Height) }
            else { $result.rect = 'EMPTY' }
            $detail = ('scrollIntoView=' + $rz.steps.scrollIntoView + ' realize=' + $rz.steps.realize + ' setFocus=' + $rz.steps.setFocus + ' rect=' + $result.rect)
          } else {
            $pt = Get-AmSafeClickPoint $rz.rect
            $result.rect = ('' + [int]$rz.rect.Left + ',' + [int]$rz.rect.Top + ' ' + [int]$rz.rect.Width + 'x' + [int]$rz.rect.Height)

            $base = Get-AmSmtcState
            if (-not $result.baseline.status) { $result.baseline = @{ status = $base.status; title = $base.title; artist = $base.artist; hasSession = $base.ok } }

            # ---- 6. synthesized double click on the left safe area ----
            $ck = Invoke-AmRowPlay $hwnd $cand.element $pt.x $pt.y -NoForeground:$NoForeground
            $a.clickMs = $ck.ms
            $result.noForeground = [bool]$NoForeground
            $result.clickPoint = ('' + $ck.x + ',' + $ck.y)
            $result.clickRecomputed = $ck.recomputed
            if (-not $ck.ok) { $stage = 'CLICK_FAILED'; $detail = $ck.detail }
            else {
              # ---- 6b. click landed: hand the screen back before the SMTC wait ----
              Start-Sleep -Milliseconds 250
              $result.minimizedAfterClick = Minimize-AmWindow $hwnd
              # ---- 7. SMTC is the only success criterion ----
              $v = Wait-AmPlayback $Title $Artist $TimeoutMs
              $a.smtcMs = $v.elapsedMs
              $result.smtc = @{
                title = $v.title; artist = $v.artist; status = $v.status; pos = $v.pos; posMs = $v.posMs
                sawPlaying = $v.sawPlaying; sawPlayingWrong = $v.sawPlayingWrong; firstWrongMs = $v.firstWrongMs
                wrongTitles = $v.wrongTitles; statuses = $v.statuses; hasSession = $v.hasSession
              }
              if ($v.result -eq 'MATCH') { $stage = 'OK'; $detail = ''; $result.ok = $true }
              elseif ($v.result -eq 'WRONG_TRACK') { $stage = 'SMTC_WRONG_TRACK'; $detail = ('playing="' + $v.title + '" status=' + $v.status + ' sawWrong=' + $v.sawPlayingWrong) }
              else { $stage = 'SMTC_TIMEOUT'; $detail = ('status=' + $v.status + ' title="' + $v.title + '" sawPlaying=' + $v.sawPlaying) }
            }
          }
        }
      }
    }

    $a.e2eMs = [int]$sw.ElapsedMilliseconds
    $result.t = $a
    $result.stage = $stage
    $result.stageDetail = $detail
    $result.stageHistory = @($result.stageHistory) + @($stage)
    if ($result.ok) { break }
    if ($attempt -lt $Retries) { Start-Sleep -Milliseconds 500 }
  }

  $result.t.e2eMs = [int]$totalSw.ElapsedMilliseconds
  $result.ts = (Get-AmIsoNow); $result.tsMs = (Get-AmNowMs)
  if (-not $result.ok -and $ShotPath) { [void](Save-AmShot $ShotPath) }
  return $result
}
