# Bounded UIA materialize scroll for off-screen rows (2026-09-26)

Authorised by the user as option B, after considering and rejecting "make Apple Music fullscreen":
not every album is short, and user playlists are coming, so fullscreen would only postpone the problem.

## Symptom

Clicking an AM result while Apple Music shows a long album page left the row waiting; the user had to
scroll the Apple Music window until the target track appeared, and only then did the pending click fire.

Evidence: the album page for `Dawn FM` showed tracks 1-4 in the viewport, while the requested song sits at
track 7 - below the fold. Apple Music virtualizes that list, so an off-screen row is **not in the UIA tree
at all**: no `ScrollIntoView`, no `Realize`, no `SetFocus` can reach an element that does not exist yet.

## Why it was stuck in the chain

- `Realize-AmRow` (`am-uia.ps1:437`) needs an element it can call patterns on; the comment there already
  records that calling `ScrollIntoView`/`Realize` on the album track list can *re-empty* the rectangle.
- The discovery loops live in `am-play.ps1` (`deeplink` page wait at 126-161, search wait at 187-194,
  a second page wait at 231-235) and could only re-scan `Get-AmListItems`. With the target row unrealized
  the scan returns nothing and the loop simply spun until the page-wait cap expired.

The earlier passing E2E (`candidateCount=1`, row already realized) was a single-song page, which is why this
never showed up before.

## Change (one file)

`poc/lib/am-play.ps1`, inside the deeplink page-wait loop only:

- initialise a materialize budget before the loop: `$materializeSteps = 0`, `$maxMaterializeSteps = 8`,
  `$materializeIntervalMs = 1000`, `$nextMaterializeMs = $materializeIntervalMs`;
- when no candidate with geometry was found and at least one interval has passed, call the chain's own
  `Scroll-AmView $hwnd -1 3` (downward wheel scroll, already used by `Realize-AmRow` stage 2), record
  `$a.materializeSteps`, and let the loop re-scan.

Properties: downward only, at most 8 steps, no sooner than 1000 ms apart, bounded by the unchanged
`$PageWaitMs` cap, no new input primitive, no change to candidate selection, click, or SMTC verification.

## Frozen-chain status after this change

| file | vs 0170bca |
|---|---|
| `am-uia.ps1` | byte-identical |
| `am-smtc.ps1` | byte-identical |
| `am-common.ps1` | byte-identical |
| `am-play.ps1` | **deviates - authorised exception** |

Baseline hashes for `am-play.ps1` (SHA256, method: `git cat-file blob` for the old revision,
`Get-FileHash` on the working tree for the new one) are recorded in the commit message.

## Verification status

- PowerShell parse check: 0 errors.
- Static: the three other `poc/lib` files verified byte-identical to `0170bca` via `git diff`.
- Runtime: **not run by the assistant** - a real run means actually starting playback in Apple Music, and
  pressing play on the user's behalf is not something this project does. The user runs that one click.